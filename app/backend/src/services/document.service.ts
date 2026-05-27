import axios from 'axios';
import FormData from 'form-data';
import { config } from '../config/env';
import { DocumentUploadResponse } from '../types/chi.types';

// Document service lives on a separate host: ix-uat.careinsurance.com
// Auth flow: POST /api/auth/login → get JWT → use for uploads

let docToken: string | null = null;

async function getDocToken(): Promise<string> {
  if (docToken) return docToken;

  const { data } = await axios.post(
    `${config.chi.docBaseUrl}/api/auth/login`,
    { username: config.chi.docUsername, password: config.chi.docPassword },
    { headers: { 'Content-Type': 'application/json' } }
  );

  docToken = data.data?.token || data.token;
  return docToken as string;
}

export function clearDocToken() { docToken = null; }

export async function uploadDocument(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
  documentType: string = 'OVD_KYC'
): Promise<DocumentUploadResponse> {
  const token = await getDocToken();

  const form = new FormData();
  form.append('file', fileBuffer, { filename: fileName, contentType: mimeType });
  form.append('document_category', documentType);

  try {
    const { data } = await axios.post<DocumentUploadResponse>(
      `${config.chi.docBaseUrl}/api/docservice/v1/upload`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${token}`,
        },
      }
    );
    return data;
  } catch (err: any) {
    if (err.response?.status === 401) clearDocToken();
    throw err;
  }
}
