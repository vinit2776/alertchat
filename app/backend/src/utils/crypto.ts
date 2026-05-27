import crypto from 'crypto';

// AES-256-CBC keys hardcoded in CHI integration docs (used for tokenId and bank details)
const AES_KEY = 'z5yK1lw7XYt6YKdP7Pne2Jw3zRkMAziH';
const AES_IV  = 'i0kbCAlFTlDXshYV';

function encrypt(plaintext: string): string {
  const key = Buffer.from(AES_KEY, 'utf8');
  const iv  = Buffer.from(AES_IV,  'utf8');
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  // CHI requires double-base64: encrypt → base64 → base64 again
  const base64Once = encrypted.toString('base64');
  return Buffer.from(base64Once).toString('base64');
}

/** Build the tokenId header value: Base64(AES("tokenKey|tokenValue")) */
export function buildTokenId(tokenKey: string, tokenValue: string): string {
  return encrypt(`${tokenKey}|${tokenValue}`);
}

/** Encrypt a bank account number or IFSC code as required by CHI */
export function encryptBankField(value: string): string {
  return encrypt(value);
}
