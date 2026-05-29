import sharp from 'sharp';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/env';
import { DocumentType, ExtractedDocument } from '../types';

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: config.anthropicApiKey });
  return _client;
}

// Preprocess image: normalise to PNG, boost contrast, limit max dimension
async function preprocess(buffer: Buffer, mimeType: string): Promise<{ data: string; mediaType: 'image/png' }> {
  let pipeline = sharp(buffer);

  // PDF pages come in as already-rasterised buffers from multer
  if (mimeType === 'application/pdf') {
    // Sharp can handle PDFs on some systems; fall back to raw buffer if not
    pipeline = sharp(buffer, { pages: 1 });
  }

  const processed = await pipeline
    .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
    .greyscale()
    .normalise()
    .sharpen()
    .png()
    .toBuffer();

  return { data: processed.toString('base64'), mediaType: 'image/png' };
}

const EXTRACT_PROMPT = `You are an expert at reading Indian insurance and vehicle documents.

Extract all fields from this document image. Return ONLY a valid JSON object with:
{
  "docType": "RC" | "PAN" | "AADHAAR" | "DRIVING_LICENCE" | "POLICY" | "OTHER",
  "confidence": 0.0–1.0,
  "fields": {
    // For RC: "registration_number", "chassis_number", "engine_number", "make", "model",
    //         "vehicle_class", "fuel_type", "cubic_capacity", "seating_capacity",
    //         "manufacturing_year", "registration_date",
    //         "rto_code" (first 4 chars of registration_number, e.g. "TN07" not "TN"),
    //         "owner_name", "owner_address", "hypothecation_bank"
    // For PAN: "pan_number", "name", "dob", "fathers_name"
    // For AADHAAR: "aadhaar_number" (last 4 digits only), "name", "dob", "gender", "address"
    // For POLICY: "policy_number", "insurer", "insured_name", "vehicle_number",
    //              "policy_start", "policy_end", "ncb_percentage", "idv", "premium"
  },
  "rawText": "all visible text concatenated"
}

Rules:
- Only include fields clearly visible in the document
- If a field is partially obscured, include best-effort value with lower confidence
- For Aadhaar: only extract last 4 digits of number, mask the rest
- Do not invent or guess values not visible in the image
- Return raw JSON only, no markdown`;

export async function extractDocument(
  fileBuffer: Buffer,
  mimeType: string
): Promise<ExtractedDocument> {
  const image = await preprocess(fileBuffer, mimeType);

  const response = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: [
          {
            type:   'image',
            source: { type: 'base64', media_type: image.mediaType, data: image.data },
          },
          { type: 'text', text: EXTRACT_PROMPT },
        ],
      },
    ],
  });

  const text = response.content.find(b => b.type === 'text')?.text ?? '';

  let parsed: any;
  try {
    const json = text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Document is unclear or unreadable. Please upload a well-lit, in-focus photo and try again.');
  }

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
    rawText:    typeof parsed.rawText === 'string' ? parsed.rawText : text,
  };
}

// Minimum confidence to accept — anything below this rejects the image
const MIN_CONFIDENCE = 0.65;

