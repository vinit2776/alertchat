import dotenv from 'dotenv';
dotenv.config({ override: true });

export const config = {
  port:        parseInt(process.env.PORT || '4001', 10),
  nodeEnv:     process.env.NODE_ENV || 'development',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',

  jwtSecret:  process.env.JWT_SECRET || 'change-me-in-production',
  jwtExpires: process.env.JWT_EXPIRES || '8h',

  // AES-256-GCM key for credential vault (32 ASCII chars or 64 hex chars)
  credentialEncryptionKey: process.env.CREDENTIAL_ENCRYPTION_KEY || '',

  databaseUrl: process.env.DATABASE_URL || '',

  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',

  langfuse: {
    publicKey: process.env.LANGFUSE_PUBLIC_KEY || '',
    secretKey: process.env.LANGFUSE_SECRET_KEY || '',
    baseUrl:   process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
  },

  aws: {
    region:          process.env.AWS_REGION || 'ap-south-1',
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },

  s3: {
    bucket:   process.env.S3_BUCKET || 'alert-insurance-quotes',
    endpoint: process.env.S3_ENDPOINT || '',
  },

  // ── Bajaj Allianz API ────────────────────────────────────────────────────
  // Credentials provided by BAGIC IT team after UAT testing is approved.
  // useProd=false → UAT endpoint (webservicesint.bajajallianz.com)
  // useProd=true  → TP/Production endpoint (api.bagicpt.bajajallianz.com)
  bajaj: {
    userId:   process.env.BAJAJ_USER_ID   || '',
    password: process.env.BAJAJ_PASSWORD  || '',
    imdCode:  process.env.BAJAJ_IMD_CODE  || '',  // agent/broker IMD code
    useProd:  process.env.BAJAJ_USE_PROD  === 'true',
  },
};
