import dotenv from 'dotenv';
dotenv.config({ override: true });

export const config = {
  port:        parseInt(process.env.PORT || '4001', 10),
  nodeEnv:     process.env.NODE_ENV || 'development',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',

  jwtSecret:  process.env.JWT_SECRET || 'change-me-in-production',
  jwtExpires: process.env.JWT_EXPIRES || '8h',

  databaseUrl: process.env.DATABASE_URL || '',

  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',

  aws: {
    region:          process.env.AWS_REGION || 'ap-south-1',
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },

  s3: {
    bucket:   process.env.S3_BUCKET || 'alert-insurance-quotes',
    endpoint: process.env.S3_ENDPOINT || '',
  },
};
