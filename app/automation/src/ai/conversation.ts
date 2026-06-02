import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/env';
import { SessionState, InsuranceType, ExtractedDocument, AuditEvent, GapField } from '../types';
import { logEvent } from '../audit/logger';
import {
  loadEntry, getCached, saveEntry, deleteEntry, cacheSize,
} from '../session/session-store';
import { getLangfuse } from './langfuse-client';
import { analyzeGapsForAll } from '../portal/knowledge-engine';

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic(config.anthropicApiKey ? { apiKey: config.anthropicApiKey } : {});
  return _client;
}

// Fallback field keys for insurance types that don't have a requirements.json yet.
// These are replaced by per-insurer knowledge once requirements.json is added.
const FALLBACK_REQUIRED_KEYS: Record<InsuranceType, string[]> = {
  motor:    ['registration_number', 'manufacturing_year', 'fuel_type', 'ncb_percentage'],
  health:   ['member_count', 'eldest_age', 'cover_type', 'sum_insured', 'tenure'],
  property: ['property_type', 'property_address', 'built_up_area', 'property_value', 'owner_mobile'],
  travel:   ['destination', 'departure_date', 'return_date', 'traveller_count', 'passport_numbers'],
};

/** Compute the union of gaps across all selected insurers. */
function computeGaps(state: SessionState): GapField[] {
  const allFields = { ...state.extractedFields, ...state.collectedFields };

  const { gaps } = analyzeGapsForAll(state.selectedCompanies, allFields);

  // If no companies have a requirements.json yet, fall back to generic key list
  if (gaps.length === 0 && state.selectedCompanies.length > 0) {
    const fallbackKeys = FALLBACK_REQUIRED_KEYS[state.insuranceType] ?? [];
    return fallbackKeys
      .filter(k => !allFields[k])
      .map(k => ({ key: k, label: k, question: `Please provide: ${k}`, type: 'string' }));
  }

  return gaps;
}

function buildSystemPrompt(state: SessionState, companies: string[]): string {
  const companyList = companies.length ? companies.join(', ') : 'selected insurance companies';

  // Compute live gaps so the prompt always reflects current state
  const gaps = computeGaps(state);
  const requiredGaps  = gaps.filter(g => !g.optional);
  const optionalGaps  = gaps.filter(g =>  g.optional);

  const stillNeededLines = requiredGaps.length
    ? requiredGaps.map(g => `  • ${g.label}: ${g.question}`).join('\n')
    : '  (all required fields collected)';

  const optionalLines = optionalGaps.length
    ? '\nOPTIONAL (ask only if user wants to customise):\n' +
      optionalGaps.map(g => `  • ${g.label}: ${g.question}`).join('\n')
    : '';

  // Also show exclusions so the AI can warn the user
  const allFields = { ...state.extractedFields, ...state.collectedFields };
  const { exclusions } = analyzeGapsForAll(state.selectedCompanies, allFields);
  const exclusionLines = Object.entries(exclusions)
    .map(([id, msg]) => `  ⚠ ${id.toUpperCase()}: ${msg}`)
    .join('\n');

  return `You are a smart insurance advisor for Alert Insurance. You are helping the user get ${state.insuranceType} insurance quotes from: ${companyList}.

Your job is to collect all required information conversationally, then trigger the quote.

ALREADY COLLECTED (from document OCR and previous answers):
${[...Object.entries(state.extractedFields), ...Object.entries(state.collectedFields)]
    .map(([k, v]) => `  ${k}: ${v}`).join('\n') || '  (none yet)'}

STILL NEEDED (ask these before triggering the quote):
${stillNeededLines}${optionalLines}
${exclusionLines ? `\nEXCLUSIONS FOR SOME INSURERS:\n${exclusionLines}` : ''}

Guidelines:
- Ask for 1-2 missing required fields per turn — never dump everything at once
- Use the exact question text from "STILL NEEDED" above so users understand what's needed and why
- Be warm, use Indian insurance terminology (₹, Lakhs, NCB, IDV, etc.)
- Accept the user's answer and move to the next missing field
- When ALL required fields are collected, call the collect_fields tool with all confirmed values
- If the user asks "what do you need?", list the remaining required fields with their purpose
- Do not fabricate insurance terms or quote numbers
- If an exclusion applies (e.g. EV not supported by UIIC), inform the user clearly

CRITICAL — HOW QUOTES WORK:
- When all fields are ready, a "🚀 Get Quotes Now" button appears in the chat UI
- The user must CLICK that button to fetch the live quote from the portal — it takes ~30-60 seconds
- DO NOT say "our team will process your quote" or "we will get back to you by email/phone"
- DO NOT promise email delivery — quotes appear instantly in this chat window
- If the user says "yes" / "confirm" / "go ahead" after the summary, tell them to click the "🚀 Get Quotes Now" button
- The quote result (premium amount) will be shown directly in this chat once the portal responds`;
}

const COLLECT_TOOL: Anthropic.Tool = {
  name: 'collect_fields',
  description: 'Called when all required fields have been collected. After this, show a summary and instruct the user to click the "🚀 Get Quotes Now" button that will appear in the chat UI to fetch the live premium from the portal.',
  input_schema: {
    type: 'object' as const,
    properties: {
      fields: {
        type: 'object',
        description: 'All confirmed field values as key-value pairs',
        additionalProperties: { type: 'string' },
      },
      ready_for_quote: {
        type: 'boolean',
        description: 'Must be true — confirms all fields are present',
      },
    },
    required: ['fields', 'ready_for_quote'],
  },
};

export function createSession(
  userId: string,
  userEmail: string,
  insuranceType: InsuranceType,
  selectedCompanies: string[]
): SessionState {
  const sessionId = uuidv4();
  const state: SessionState = {
    sessionId,
    userId,
    insuranceType,
    selectedCompanies,
    extractedFields:  {},
    collectedFields:  {},
    confirmedFields:  {},
    missingRequired:  [],   // populated by computeGaps after state is constructed
    currentStep:      'collecting',
    status:           'collecting',
    createdAt:        Date.now(),
    updatedAt:        Date.now(),
  };

  // Populate missingRequired from knowledge engine (empty fields at session start)
  state.missingRequired = computeGaps(state).map(g => g.key);

  saveEntry({ state, history: [] });

  logEvent({
    userId, userEmail, sessionId,
    insType:  insuranceType,
    action:   'session_start',
    outcome:  'success',
    meta: { selectedCompanies, insuranceType },
  } as AuditEvent);

  return state;
}

/** Synchronous getter — only sees cached sessions. For full lookup use ensureSession. */
export function getSession(sessionId: string): SessionState | null {
  return getCached(sessionId)?.state ?? null;
}

/**
 * Full session lookup: checks cache, falls back to DB.
 * Use this in async route handlers — it survives backend restarts.
 */
export async function ensureSession(sessionId: string): Promise<SessionState | null> {
  const entry = await loadEntry(sessionId);
  return entry?.state ?? null;
}

/** Persist current state — call after any mutation to a session. */
export function persistSession(sessionId: string): void {
  const entry = getCached(sessionId);
  if (entry) saveEntry(entry);
}

export async function applyOcrResult(
  sessionId: string,
  userId: string,
  userEmail: string,
  doc: ExtractedDocument
): Promise<SessionState | null> {
  const entry = await loadEntry(sessionId);
  if (!entry) return null;

  const { state } = entry;

  // Merge extracted fields
  for (const [k, v] of Object.entries(doc.fields)) {
    if (v) state.extractedFields[k] = v;
  }

  // Recompute gaps from knowledge engine after merging new OCR fields
  state.missingRequired = computeGaps(state).map(g => g.key);
  state.updatedAt = Date.now();

  saveEntry(entry);  // persist after mutation

  logEvent({
    userId, userEmail, sessionId,
    action:  'ocr_complete',
    outcome: 'success',
    meta: {
      docType:          doc.docType,
      fieldsExtracted:  Object.keys(doc.fields).length,
      confidence:       doc.confidence,
      fieldNames:       Object.keys(doc.fields),  // names only, no values
    },
  } as AuditEvent);

  return state;
}

export interface ChatTurn {
  message:     string;
  sessionId:   string;
  status:      SessionState['status'];
  fieldsReady: boolean;
  confirmedFields?: Record<string, string>;
}

export async function processMessage(
  sessionId: string,
  userId: string,
  userEmail: string,
  userMessage: string,
  companyNames: string[]
): Promise<ChatTurn> {
  const entry = await loadEntry(sessionId);
  if (!entry) {
    return { message: 'Session not found. Please start a new chat.', sessionId, status: 'error', fieldsReady: false };
  }

  const { state, history } = entry;
  history.push({ role: 'user', content: userMessage });

  const lf    = getLangfuse();
  const trace = lf?.trace({
    name:     'chat-turn',
    userId,
    sessionId,
    metadata: { insuranceType: state.insuranceType, selectedCompanies: state.selectedCompanies },
    tags:     [state.insuranceType, 'chat'],
  });

  const MODEL        = 'claude-sonnet-4-6';
  const systemPrompt = buildSystemPrompt(state, companyNames);

  const gen1 = trace?.generation({
    name:  'chat-collect',
    model: MODEL,
    input: { system: systemPrompt, messages: history },
  });
  const response = await getClient().messages.create({
    model: MODEL, max_tokens: 1024, system: systemPrompt, tools: [COLLECT_TOOL], messages: history,
  });
  gen1?.end({
    output: response.content,
    usage:  { input: response.usage.input_tokens, output: response.usage.output_tokens, unit: 'TOKENS' },
  });

  const toolCall = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

  if (toolCall?.name === 'collect_fields') {
    const input = toolCall.input as { fields: Record<string, string>; ready_for_quote: boolean };

    for (const [k, v] of Object.entries(input.fields)) state.collectedFields[k] = v;
    state.confirmedFields = { ...state.extractedFields, ...state.collectedFields };
    state.missingRequired = computeGaps(state).map(g => g.key);
    state.status    = state.missingRequired.length === 0 ? 'confirming' : 'collecting';
    state.updatedAt = Date.now();

    history.push({ role: 'assistant', content: response.content });
    history.push({
      role:    'user',
      content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: 'Fields collected successfully' }],
    });

    const confirmSystemPrompt = buildSystemPrompt(state, companyNames);
    const gen2 = trace?.generation({
      name:  'chat-confirm',
      model: MODEL,
      input: { system: confirmSystemPrompt, messages: history },
    });
    const confirmResponse = await getClient().messages.create({
      model: MODEL, max_tokens: 1024, system: confirmSystemPrompt, tools: [COLLECT_TOOL], messages: history,
    });
    const confirmText = confirmResponse.content.find(b => b.type === 'text')?.text
      ?? 'All details collected. Please confirm to proceed.';
    gen2?.end({
      output: confirmText,
      usage:  { input: confirmResponse.usage.input_tokens, output: confirmResponse.usage.output_tokens, unit: 'TOKENS' },
    });
    history.push({ role: 'assistant', content: confirmResponse.content });

    logEvent({
      userId, userEmail, sessionId,
      action:  'fields_confirmed', outcome: 'success',
      meta:    { fieldCount: Object.keys(state.confirmedFields).length, fieldNames: Object.keys(state.confirmedFields) },
    } as AuditEvent);

    saveEntry(entry);
    trace?.update({ output: confirmText, metadata: { fieldsCollected: Object.keys(state.confirmedFields).length } });
    return { message: confirmText, sessionId, status: 'confirming', fieldsReady: true, confirmedFields: state.confirmedFields };
  }

  const nextMissing = state.missingRequired[0];
  if (nextMissing && userMessage.length > 1) {
    logEvent({ userId, userEmail, sessionId, action: 'field_collected_chat', outcome: 'success', meta: { fieldName: nextMissing } } as AuditEvent);
  }

  const message = response.content.find(b => b.type === 'text')?.text ?? '';
  history.push({ role: 'assistant', content: response.content });

  saveEntry(entry);
  trace?.update({ output: message });
  return { message, sessionId, status: state.status, fieldsReady: false };
}

export function deleteSession(sessionId: string) {
  deleteEntry(sessionId);
}

export function getSessionStats() {
  return { activeSessions: cacheSize() };
}
