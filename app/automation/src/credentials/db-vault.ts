// DB-backed credential vault with AES-256-GCM encryption.
// Requires CREDENTIAL_ENCRYPTION_KEY env var (32 bytes / 64 hex chars).

import crypto from 'crypto';
import { query, queryOne } from '../db/client';
import type { PortalCredentials } from './vault';

const ALGO = 'aes-256-gcm';

function getKey(): Buffer {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY || '';
  if (raw.length === 64) return Buffer.from(raw, 'hex');
  if (raw.length === 32) return Buffer.from(raw, 'utf8');
  throw new Error('CREDENTIAL_ENCRYPTION_KEY must be 32 ASCII chars or 64 hex chars');
}

function encrypt(plaintext: string): { enc: string; iv: string; tag: string } {
  const key = getKey();
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv) as crypto.CipherGCM;
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    enc: enc.toString('base64'),
    iv:  iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decrypt(enc: string, iv: string, tag: string): string {
  const key     = getKey();
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(iv, 'base64')) as crypto.DecipherGCM;
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(enc, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export async function saveCredentials(portalId: string, creds: PortalCredentials): Promise<void> {
  const pw    = encrypt(creds.password);
  const extra = creds.agentCode || creds.branchCode
    ? encrypt(JSON.stringify({ agentCode: creds.agentCode, branchCode: creds.branchCode }))
    : null;

  await query(
    `INSERT INTO portal_credentials
       (portal_id, username, password_enc, iv, auth_tag, extra_enc, extra_iv, extra_tag, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
     ON CONFLICT (portal_id) DO UPDATE SET
       username     = EXCLUDED.username,
       password_enc = EXCLUDED.password_enc,
       iv           = EXCLUDED.iv,
       auth_tag     = EXCLUDED.auth_tag,
       extra_enc    = EXCLUDED.extra_enc,
       extra_iv     = EXCLUDED.extra_iv,
       extra_tag    = EXCLUDED.extra_tag,
       updated_at   = now()`,
    [
      portalId,
      creds.username,
      pw.enc, pw.iv, pw.tag,
      extra?.enc ?? null, extra?.iv ?? null, extra?.tag ?? null,
    ],
  );
}

export async function loadCredentials(portalId: string): Promise<PortalCredentials | null> {
  const row = await queryOne<any>(
    'SELECT * FROM portal_credentials WHERE portal_id = $1',
    [portalId],
  );
  if (!row) return null;

  const password = decrypt(row.password_enc, row.iv, row.auth_tag);
  let extra: Record<string, string> = {};
  if (row.extra_enc && row.extra_iv && row.extra_tag) {
    extra = JSON.parse(decrypt(row.extra_enc, row.extra_iv, row.extra_tag));
  }

  return { username: row.username, password, ...extra };
}

export async function deleteCredentials(portalId: string): Promise<void> {
  await query('DELETE FROM portal_credentials WHERE portal_id = $1', [portalId]);
}

export async function hasCredentials(portalId: string): Promise<boolean> {
  const row = await queryOne<{ portal_id: string }>(
    'SELECT portal_id FROM portal_credentials WHERE portal_id = $1',
    [portalId],
  );
  return !!row;
}
