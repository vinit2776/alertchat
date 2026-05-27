import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';
import { verifyToken } from './auth/login.js';

// ── Auth ───────────────────────────────────────────────────────────────────

function requireAuth(req: VercelRequest, res: VercelResponse): boolean {
  const auth  = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!verifyToken(token)) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return false;
  }
  return true;
}

// ── Claude setup ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a friendly insurance advisor at Alert Insurance helping customers get a health insurance quote.

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
   (Enhance 1 = base plan; Enhance 2 = richer coverage — suggest Enhance 2 as default)
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
  description: 'Generate a health insurance premium quote once all required information is collected.',
  input_schema: {
    type: 'object' as const,
    properties: {
      field_1:  { type: 'number', description: 'Total members (1–6)' },
      field_10: { type: 'number', description: 'Children under 25 years (0 or 1)' },
      field_9:  { type: 'string', enum: ['Individual', 'Floater'], description: 'Cover type' },
      field_3:  {
        type: 'string',
        enum: ['18 to 24 Years','25 to 35 Years','36 to 40 Years','41 to 45 Years',
               '46 to 50 Years','51 to 55 Years','56 to 60 Years','61 to 65 Years',
               '66 to 70 Years','> 70 Years'],
        description: 'Age bracket of eldest member',
      },
      field_23: { type: 'string', enum: ['Enhance 1', 'Enhance 2'], description: 'Plan variant' },
      field_11: { type: 'number', enum: [5, 10, 15, 20], description: 'Deductible in Lakhs' },
      field_2:  { type: 'number', enum: [45, 55], description: 'Sum insured in Lakhs' },
      field_4:  { type: 'string', enum: ['1 Year', '2 Year', '3 Year'], description: 'Policy tenure' },
    },
    required: ['field_1','field_10','field_9','field_3','field_23','field_11','field_2','field_4'],
  },
};

// ── Premium calculator (fallback when CHI API is unavailable) ─────────────

interface QuoteInput {
  field_1: number; field_10: number; field_9: string; field_3: string;
  field_23: string; field_11: number; field_2: number; field_4: string;
}

function computePremium(input: QuoteInput) {
  const ageFactor: Record<string, number> = {
    '18 to 24 Years': 0.7, '25 to 35 Years': 0.85, '36 to 40 Years': 1.0,
    '41 to 45 Years': 1.2, '46 to 50 Years': 1.45, '51 to 55 Years': 1.75,
    '56 to 60 Years': 2.1, '61 to 65 Years': 2.5, '66 to 70 Years': 3.0, '> 70 Years': 3.6,
  };
  const tenureFactor: Record<string, number> = { '1 Year': 1.0, '2 Year': 1.85, '3 Year': 2.65 };
  const planFactor   = input.field_23 === 'Enhance 2' ? 1.12 : 1.0;
  const deductFactor = 1 - (input.field_11 - 5) * 0.025;

  const base = input.field_2 * 800
    * (ageFactor[input.field_3] ?? 1.0)
    * Math.sqrt(input.field_1)
    * planFactor
    * deductFactor
    * (tenureFactor[input.field_4] ?? 1.0);

  const basePremium = Math.round(base);
  const gst         = Math.round(base * 0.18);
  const total       = basePremium + gst;

  return {
    basePremium: basePremium.toLocaleString('en-IN'),
    premium:     total.toLocaleString('en-IN'),
    premiumWithAddOn: Math.round(total * 1.14).toLocaleString('en-IN'),
  };
}

// ── CHI API quotation ─────────────────────────────────────────────────────

async function fetchRealQuote(input: QuoteInput) {
  const chiBase = process.env.CHI_ABACUS_BASE_URL ?? '';
  if (!chiBase || chiBase.includes('localhost')) return null; // skip if mock

  const authRes = await fetch(
    `${chiBase}/religare_api/api/web/v1/auth/access-token?formattype=json`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key:     process.env.CHI_ABACUS_API_KEY,
        auth_secret: process.env.CHI_ABACUS_AUTH_SECRET,
      }),
    },
  );
  const authData = await authRes.json() as any;
  if (!authData.status) return null;

  const quotRes = await fetch(
    `${chiBase}/religare_api/api/web/v1/abacus/partner?formattype=json`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authData.data.token}` },
      body: JSON.stringify({
        partnerId: process.env.CHI_PARTNER_ID,
        abacusId:  process.env.CHI_ABACUS_ID,
        postedField: { ...input, outPutField: 'field_8', field_14: 1 },
      }),
    },
  );
  const quotData = await quotRes.json() as any;
  const outputFields = quotData?.data?.outputFields ?? [];
  const f8  = outputFields.find((f: any) => f.fieldName === 'field_8');
  const f14 = outputFields.find((f: any) => f.fieldName === 'field_14');
  if (!f8) return null;

  return {
    basePremium:     f8.basePremium?.toString()       ?? f8.selectedValue?.toString() ?? 'N/A',
    premium:         f8.premium?.toString()            ?? f8.selectedValue?.toString() ?? 'N/A',
    premiumWithAddOn: f14?.premium?.toString()         ?? null,
    title:           quotData?.data?.abacusData?.title ?? 'Alert Insurance',
    gst:             quotData?.data?.abacusData?.serviceTax ?? '18',
  };
}

// ── Main handler ──────────────────────────────────────────────────────────

type Msg = { role: 'user' | 'assistant'; content: string | Anthropic.ContentBlock[] };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!requireAuth(req, res)) return;

  const { message, history = [] } = req.body ?? {};
  if (!message?.trim()) {
    return res.status(400).json({ success: false, message: 'message is required' });
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const messages: Msg[] = [...history, { role: 'user', content: message.trim() }];

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: [QUOTE_TOOL],
      messages: messages as Anthropic.MessageParam[],
    });

    const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

    if (toolUse?.name === 'generate_quote') {
      const input = toolUse.input as QuoteInput;
      const updatedMessages: Msg[] = [...messages, { role: 'assistant', content: response.content }];

      // Try real CHI API first, fall back to computed premium
      let premiumData = await fetchRealQuote(input).catch(() => null);
      if (!premiumData) {
        const computed = computePremium(input);
        premiumData = { ...computed, title: 'Alert Insurance', gst: '18' };
      }

      const quote = {
        ...premiumData,
        members:    input.field_1,
        coverType:  input.field_9,
        sumInsured: input.field_2,
        deductible: input.field_11,
        tenure:     input.field_4,
        plan:       input.field_23,
      };

      const toolResultMessages: Msg[] = [
        ...updatedMessages,
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(quote) }] as any },
      ];

      const final = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: [QUOTE_TOOL],
        messages: toolResultMessages as Anthropic.MessageParam[],
      });

      const totalIn  = (response.usage.input_tokens  + final.usage.input_tokens);
      const totalOut = (response.usage.output_tokens + final.usage.output_tokens);
      const costUsd  = (totalIn / 1_000_000) * 0.80 + (totalOut / 1_000_000) * 4.00;
      console.log(`[usage] turn=quote in=${totalIn} out=${totalOut} cost_usd=${costUsd.toFixed(6)}`);

      const finalText = final.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
      const finalMessages: Msg[] = [...toolResultMessages, { role: 'assistant', content: final.content }];

      return res.json({ success: true, message: finalText, quote, history: finalMessages,
        _usage: { inputTokens: totalIn, outputTokens: totalOut, costUsd: parseFloat(costUsd.toFixed(6)) } });
    }

    // Normal conversational turn
    const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
    const finalMessages: Msg[] = [...messages, { role: 'assistant', content: response.content }];

    const costUsd = (response.usage.input_tokens / 1_000_000) * 0.80 + (response.usage.output_tokens / 1_000_000) * 4.00;
    console.log(`[usage] turn=chat in=${response.usage.input_tokens} out=${response.usage.output_tokens} cost_usd=${costUsd.toFixed(6)}`);

    return res.json({ success: true, message: text, quote: null, history: finalMessages,
      _usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, costUsd: parseFloat(costUsd.toFixed(6)) } });

  } catch (err: any) {
    console.error('[chat]', err?.message ?? err);
    return res.status(500).json({ success: false, message: err?.message ?? 'Internal error' });
  }
}
