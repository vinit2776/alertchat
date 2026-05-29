import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/env';
import { SessionState, InsuranceType, ExtractedDocument, AuditEvent } from '../types';
import { logEvent } from '../audit/logger';

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: config.anthropicApiKey });
  return _client;
}

// In-memory session store (Phase 1 — replaced with Redis in Phase 2)
const sessions = new Map<string, { state: SessionState; history: Anthropic.MessageParam[] }>();

// Required fields per insurance type
const REQUIRED_FIELDS: Record<InsuranceType, string[]> = {
  motor:    ['registration_number', 'make', 'model', 'manufacturing_year', 'fuel_type',
             'ncb_percentage', 'previous_policy_expiry', 'owner_mobile', 'owner_email'],
  health:   ['member_count', 'eldest_age', 'cover_type', 'sum_insured', 'tenure'],
  property: ['property_type', 'property_address', 'built_up_area', 'property_value', 'owner_mobile'],
  travel:   ['destination', 'departure_date', 'return_date', 'traveller_count', 'passport_numbers'],
};

function buildSystemPrompt(state: SessionState, companies: string[]): string {
  const companyList = companies.length ? companies.join(', ') : 'selected insurance companies';
  return `You are a smart insurance advisor for Alert Insurance. You are helping the user get ${state.insuranceType} insurance quotes from: ${companyList}.

Your job is to collect all required information conversationally, then trigger the quote.

ALREADY COLLECTED (from document OCR):
${Object.entries(state.extractedFields).map(([k, v]) => `  ${k}: ${v}`).join('\n') || '  (none yet)'}

COLLECTED FROM CHAT:
${Object.entries(state.collectedFields).map(([k, v]) => `  ${k}: ${v}`).join('\n') || '  (none yet)'}

STILL NEEDED:
${state.missingRequired.join(', ') || '(all fields collected)'}

Guidelines:
- Ask for 1-2 missing fields per turn, never dump everything at once
- Be warm, use Indian insurance terminology (₹, Lakhs, NCB, IDV, etc.)
- If the user provides a value, accept it and ask for the next missing field
- When all fields are collected, call the collect_fields tool with confirmed values
- If the user asks "what do you need?", list the remaining missing fields clearly
- Do not fabricate insurance terms or quote numbers

CRITICAL — HOW QUOTES WORK:
- When all fields are ready, a "🚀 Get Quotes Now" button appears in the chat UI
- The user must CLICK that button to fetch the live quote from the portal — it takes ~30-60 seconds
- DO NOT say "our team will process your quote" or "we will get back to you by email/phone"
- DO NOT promise email delivery — quotes appear instantly in this chat window
- If the user says "yes" / "confirm" / "go ahead" after you show the summary, tell them to click the "🚀 Get Quotes Now" button that appeared below
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
    missingRequired:  [...REQUIRED_FIELDS[insuranceType]],
    currentStep:      'collecting',
    status:           'collecting',
    createdAt:        Date.now(),
    updatedAt:        Date.now(),
  };

  sessions.set(sessionId, { state, history: [] });

  logEvent({
    userId, userEmail, sessionId,
    insType:  insuranceType,
    action:   'session_start',
    outcome:  'success',
    meta: { selectedCompanies, insuranceType },
  } as AuditEvent);

  return state;
}

export function getSession(sessionId: string): SessionState | null {
  return sessions.get(sessionId)?.state ?? null;
}

export function applyOcrResult(
  sessionId: string,
  userId: string,
  userEmail: string,
  doc: ExtractedDocument
): SessionState | null {
  const entry = sessions.get(sessionId);
  if (!entry) return null;

  const { state } = entry;

  // Merge extracted fields
  for (const [k, v] of Object.entries(doc.fields)) {
    if (v) state.extractedFields[k] = v;
  }

  // Recompute missing required
  const allCollected = { ...state.extractedFields, ...state.collectedFields };
  state.missingRequired = REQUIRED_FIELDS[state.insuranceType].filter(f => !allCollected[f]);
  state.updatedAt = Date.now();

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
  const entry = sessions.get(sessionId);
  if (!entry) {
    return { message: 'Session not found. Please start a new chat.', sessionId, status: 'error', fieldsReady: false };
  }

  const { state, history } = entry;
  history.push({ role: 'user', content: userMessage });

  const response = await getClient().messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 1024,
    system:     buildSystemPrompt(state, companyNames),
    tools:      [COLLECT_TOOL],
    messages:   history,
  });

  const toolCall = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

  if (toolCall?.name === 'collect_fields') {
    const input = toolCall.input as { fields: Record<string, string>; ready_for_quote: boolean };

    // Merge chat-collected fields
    for (const [k, v] of Object.entries(input.fields)) {
      state.collectedFields[k] = v;
    }
    state.confirmedFields = { ...state.extractedFields, ...state.collectedFields };
    state.missingRequired = [];
    state.status  = 'confirming';
    state.updatedAt = Date.now();

    history.push({ role: 'assistant', content: response.content });
    history.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: 'Fields collected successfully' }],
    });

    // Get Claude's confirmation message
    const confirmResponse = await getClient().messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1024,
      system:     buildSystemPrompt(state, companyNames),
      tools:      [COLLECT_TOOL],
      messages:   history,
    });
    const confirmText = confirmResponse.content.find(b => b.type === 'text')?.text ?? 'All details collected. Please confirm to proceed.';
    history.push({ role: 'assistant', content: confirmResponse.content });

    logEvent({
      userId, userEmail, sessionId,
      action:  'fields_confirmed',
      outcome: 'success',
      meta:    { fieldCount: Object.keys(state.confirmedFields).length, fieldNames: Object.keys(state.confirmedFields) },
    } as AuditEvent);

    return { message: confirmText, sessionId, status: 'confirming', fieldsReady: true, confirmedFields: state.confirmedFields };
  }

  // Track individually chat-collected fields (field name only, no value for audit)
  const userLower = userMessage.toLowerCase();
  const nextMissing = state.missingRequired[0];
  if (nextMissing && userLower.length > 1) {
    logEvent({
      userId, userEmail, sessionId,
      action:  'field_collected_chat',
      outcome: 'success',
      meta:    { fieldName: nextMissing },
    } as AuditEvent);
  }

  const textBlock = response.content.find(b => b.type === 'text');
  const message   = textBlock?.text ?? '';
  history.push({ role: 'assistant', content: response.content });

  return { message, sessionId, status: state.status, fieldsReady: false };
}

export function deleteSession(sessionId: string) {
  sessions.delete(sessionId);
}

export function getSessionStats() {
  return { activeSessions: sessions.size };
}
