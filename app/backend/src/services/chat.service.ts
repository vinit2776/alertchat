import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/env';
import { getQuotation } from './quotation.service';

// Lazy client — ensures dotenv has loaded before the SDK reads the key
let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: config.anthropicApiKey });
  return _client;
}

const SYSTEM_PROMPT = `You are a friendly insurance advisor helping customers get a quote for Care Enhance health insurance by Care Health Insurance.

Your goal: collect the required details conversationally and generate a quote when ready.

Required information to collect:
1. Total members to insure (1–6 people)
2. Number of children under 25 years among them (0, or 1+)
3. Cover type: Individual (one person) or Floater (whole family under one cover)
4. Age of the eldest member — map to the correct bracket:
   18–24 → "18 to 24 Years", 25–35 → "25 to 35 Years", 36–40 → "36 to 40 Years",
   41–45 → "41 to 45 Years", 46–50 → "46 to 50 Years", 51–55 → "51 to 55 Years",
   56–60 → "56 to 60 Years", 61–65 → "61 to 65 Years", 66–70 → "66 to 70 Years", above 70 → "> 70 Years"
5. Plan variant: Enhance 1 or Enhance 2
   (Enhance 1 = base plan; Enhance 2 = richer coverage with higher limits — suggest Enhance 2 as default)
6. Deductible amount: 5, 10, 15, or 20 Lakhs
   (A higher deductible lowers the premium — explain briefly if customer is unsure)
7. Sum Insured: 45 Lakhs or 55 Lakhs
8. Policy tenure: 1 Year, 2 Year, or 3 Year
   (Multi-year plans offer a discount — mention this)

Conversation guidelines:
- Be warm, concise, use ₹ and Lakh terminology
- Ask 1–2 questions per turn, never dump all questions at once
- If user gives a partial answer, accept it and ask the remaining
- If user says "suggest" or "recommend", give a sensible default and explain briefly
- Once you have all 8 data points, call the generate_quote tool immediately

Do not make up premium numbers — always use the generate_quote tool for actual figures.`;

const QUOTE_TOOL: Anthropic.Tool = {
  name: 'generate_quote',
  description: 'Generate a Care Enhance premium quote once all required information is collected.',
  input_schema: {
    type: 'object' as const,
    properties: {
      field_1:  { type: 'number', description: 'Total members (1–6)' },
      field_10: { type: 'number', description: 'Children under 25 years (0 or 1)' },
      field_9:  { type: 'string', enum: ['Individual', 'Floater'], description: 'Cover type' },
      field_3:  {
        type: 'string',
        enum: ['18 to 24 Years', '25 to 35 Years', '36 to 40 Years', '41 to 45 Years',
               '46 to 50 Years', '51 to 55 Years', '56 to 60 Years', '61 to 65 Years',
               '66 to 70 Years', '> 70 Years'],
        description: 'Age bracket of eldest member',
      },
      field_23: { type: 'string', enum: ['Enhance 1', 'Enhance 2'], description: 'Plan variant' },
      field_11: { type: 'number', enum: [5, 10, 15, 20], description: 'Deductible in Lakhs' },
      field_2:  { type: 'number', enum: [45, 55], description: 'Sum insured in Lakhs' },
      field_4:  { type: 'string', enum: ['1 Year', '2 Year', '3 Year'], description: 'Policy tenure' },
    },
    required: ['field_1', 'field_10', 'field_9', 'field_3', 'field_23', 'field_11', 'field_2', 'field_4'],
  },
};

type ConversationMessage = Anthropic.MessageParam;

// In-memory session store — good enough for MVP
const sessions = new Map<string, ConversationMessage[]>();

export interface ChatResponse {
  message: string;
  quote: QuoteSummary | null;
  sessionId: string;
}

export interface QuoteSummary {
  premium: string;
  basePremium: string;
  premiumWithAddOn: string | null;
  title: string;
  members: number;
  coverType: string;
  sumInsured: number;
  deductible: number;
  tenure: string;
  plan: string;
  gst: string;
}

export async function processChat(sessionId: string, userMessage: string): Promise<ChatResponse> {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, []);
  }
  const history = sessions.get(sessionId)!;

  history.push({ role: 'user', content: userMessage });

  // First Claude call — may include a tool call
  const response = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [QUOTE_TOOL],
    messages: history,
  });

  // Check if Claude wants to call the tool
  const toolUseBlock = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

  if (toolUseBlock && toolUseBlock.name === 'generate_quote') {
    // Save assistant's tool-call turn
    history.push({ role: 'assistant', content: response.content });

    const postedField = {
      ...(toolUseBlock.input as Record<string, unknown>),
      outPutField: 'field_8',
      field_14: 1,
    };

    let quoteResult: QuoteSummary | null = null;
    let toolResultContent: string;

    try {
      const apiData = await getQuotation(postedField as Record<string, string | number>);
      const outputFields = (apiData as any)?.data?.outputFields ?? [];
      const basePremiumField = outputFields.find((f: any) => f.fieldName === 'field_8');
      const addOnField       = outputFields.find((f: any) => f.fieldName === 'field_14');
      const input = toolUseBlock.input as any;

      // Support both real CHI API format (.premium/.basePremium) and mock format (.selectedValue)
      const resolvePremium = (f: any) => f?.premium ?? f?.selectedValue ?? 'N/A';
      const resolveBase    = (f: any) => f?.basePremium ?? f?.selectedValue ?? 'N/A';

      quoteResult = {
        premium:           resolvePremium(basePremiumField),
        basePremium:       resolveBase(basePremiumField),
        premiumWithAddOn:  addOnField ? resolvePremium(addOnField) : null,
        title:             (apiData as any)?.data?.abacusData?.title ?? 'Care Enhance',
        members:           input.field_1,
        coverType:         input.field_9,
        sumInsured:        input.field_2,
        deductible:        input.field_11,
        tenure:            input.field_4,
        plan:              input.field_23,
        gst:               (apiData as any)?.data?.abacusData?.serviceTax ?? '18',
      };
      toolResultContent = JSON.stringify(quoteResult);
    } catch (err: any) {
      toolResultContent = JSON.stringify({ error: err.message ?? 'Quote API failed' });
    }

    // Feed tool result back to Claude for a user-friendly response
    history.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseBlock.id, content: toolResultContent }],
    });

    const finalResponse = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: [QUOTE_TOOL],
      messages: history,
    });

    const finalText = finalResponse.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
    history.push({ role: 'assistant', content: finalResponse.content });

    return { message: finalText, quote: quoteResult, sessionId };
  }

  // Normal text response
  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  const message   = textBlock?.text ?? '';
  history.push({ role: 'assistant', content: response.content });

  return { message, quote: null, sessionId };
}

export function clearSession(sessionId: string) {
  sessions.delete(sessionId);
}
