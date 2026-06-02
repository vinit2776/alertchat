import sharp from 'sharp';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/env';
import { DocumentType, ExtractedDocument } from '../types';

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: config.anthropicApiKey });
  return _client;
}

type AnthropicContentBlock =
  | { type: 'image';    source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg'; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf';            data: string } }
  | { type: 'text';     text: string };

// Preprocess image: normalise to PNG, boost contrast, limit max dimension.
// PDFs are NOT preprocessed — Claude accepts them as document blocks directly.
async function preprocessImage(buffer: Buffer): Promise<string> {
  const processed = await sharp(buffer)
    .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
    .greyscale()
    .normalise()
    .sharpen()
    .png()
    .toBuffer();

  return processed.toString('base64');
}

// Build the right content block for Claude based on the file type
async function toAnthropicBlock(
  buffer: Buffer,
  mimeType: string,
): Promise<AnthropicContentBlock> {
  if (mimeType === 'application/pdf') {
    // Claude reads PDFs natively — no rasterisation needed
    return {
      type:   'document',
      source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
    };
  }

  // For images: sharp handles JPEG, PNG, WEBP, HEIC (if libvips has libheif), AVIF, TIFF, etc.
  // Anything sharp can read gets normalised to PNG.
  try {
    const data = await preprocessImage(buffer);
    return { type: 'image', source: { type: 'base64', media_type: 'image/png', data } };
  } catch (err: any) {
    // If sharp can't handle it (rare formats), pass the raw buffer through if it's a known image type
    if (mimeType.startsWith('image/')) {
      const supported = ['image/jpeg', 'image/png'];
      const mediaType = (supported.includes(mimeType) ? mimeType : 'image/jpeg') as 'image/png' | 'image/jpeg';
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } };
    }
    throw new Error(`Unsupported file format (${mimeType}). Please upload a JPG, PNG, or PDF.`);
  }
}

const EXTRACT_PROMPT = `You are an expert at reading Indian insurance and vehicle documents. Extract all visible fields from this document and call the extract_fields tool with the structured result.

Field name conventions (use exactly these keys):
- RC: registration_number, chassis_number, engine_number, make, model, vehicle_class,
      fuel_type, cubic_capacity, seating_capacity, manufacturing_year, registration_date,
      rto_code (first 4 chars of registration_number, e.g. "TN07" not "TN"),
      owner_name, owner_address, hypothecation_bank
- PAN: pan_number, name, dob, fathers_name
- AADHAAR: aadhaar_number (LAST 4 DIGITS ONLY — mask the rest), name, dob, gender, address
- POLICY: policy_number, insurer, insured_name, vehicle_number, policy_start, policy_end,
          ncb_percentage, idv, premium, registration_number

Rules:
- Only include fields clearly visible in the document
- Do NOT invent or guess values not visible
- For Aadhaar: only extract last 4 digits, never the full number
- Always call the extract_fields tool — never reply with plain text`;

const EXTRACT_TOOL = {
  name: 'extract_fields',
  description: 'Return the structured field extraction for this document.',
  input_schema: {
    type: 'object' as const,
    properties: {
      docType: {
        type: 'string',
        enum: ['RC', 'PAN', 'AADHAAR', 'DRIVING_LICENCE', 'POLICY', 'OTHER'],
        description: 'Type of document detected',
      },
      confidence: {
        type: 'number',
        description: 'Overall extraction confidence from 0.0 to 1.0',
      },
      fields: {
        type: 'object',
        description: 'Extracted field values keyed by standard field name',
        additionalProperties: { type: 'string' },
      },
      rawText: {
        type: 'string',
        description: 'All visible text concatenated',
      },
    },
    required: ['docType', 'confidence', 'fields'],
  },
};

export async function extractDocument(
  fileBuffer: Buffer,
  mimeType: string
): Promise<ExtractedDocument> {
  const docBlock = await toAnthropicBlock(fileBuffer, mimeType);

  // Use Sonnet — it's significantly better at multi-page policy schedules
  // and complex tabular extraction. The forced tool call guarantees we get
  // structured output (no JSON-parsing failures).
  const response = await getClient().messages.create({
    model:       'claude-sonnet-4-5',
    max_tokens:  2048,
    tools:       [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: 'extract_fields' },
    messages: [
      {
        role: 'user',
        content: [
          docBlock as any,
          { type: 'text', text: EXTRACT_PROMPT },
        ],
      },
    ],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
  );

  if (!toolUse) {
    const rawText = response.content.find(b => b.type === 'text')?.text ?? '';
    console.error('[OCR] Claude did not call the tool. Raw response:');
    console.error(rawText.slice(0, 1000));
    throw new Error('Document could not be read. Please retake the photo in good lighting and try again.');
  }

  const parsed = toolUse.input as {
    docType:     DocumentType;
    confidence:  number;
    fields:      Record<string, string>;
    rawText?:    string;
  };

  const confidence: number = typeof parsed.confidence === 'number' ? parsed.confidence : 0;

  if (confidence < MIN_CONFIDENCE) {
    throw new Error(
      `Image quality too low to read reliably (${Math.round(confidence * 100)}% confidence). ` +
      'Please retake the photo in good lighting, keep the document flat, and ensure all text is in focus.'
    );
  }

  return {
    docType:    (parsed.docType as DocumentType) ?? 'OTHER',
    fields:     (parsed.fields as Record<string, string>) ?? {},
    confidence,
    rawText:    typeof parsed.rawText === 'string' ? parsed.rawText : '',
  };
}

// Minimum confidence to accept — anything below this rejects the image
const MIN_CONFIDENCE = 0.65;

