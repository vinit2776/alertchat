import dotenv from 'dotenv';
dotenv.config({ override: true });

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',

  chi: {
    // Policy APIs — https://apiuat.careinsurance.com/relinterfacerestful/religare/secure/restful/
    baseUrl: process.env.CHI_BASE_URL || 'https://apiuat.careinsurance.com',
    restPath: '/relinterfacerestful/religare/secure/restful',

    // Static auth headers (from CHI Tech team)
    appId:     process.env.CHI_APP_ID     || '',
    signature: process.env.CHI_SIGNATURE  || '',
    timestamp: process.env.CHI_TIMESTAMP  || '',

    // Partner token credentials
    partnerId:   process.env.CHI_PARTNER_ID   || '',
    securityKey: process.env.CHI_SECURITY_KEY || '',

    // Agent ID (static, documented as 20008325 in UAT)
    baseAgentId: process.env.CHI_BASE_AGENT_ID || '20008325',

    // Care Enhance quotation — https://abacus.careinsurance.com
    abacusBaseUrl:  process.env.CHI_ABACUS_BASE_URL   || 'https://abacus.careinsurance.com',
    abacusApiKey:   process.env.CHI_ABACUS_API_KEY    || '',
    abacusSecret:   process.env.CHI_ABACUS_AUTH_SECRET || '',
    abacusId:       process.env.CHI_ABACUS_ID          || '',

    // Document service — https://ix-uat.careinsurance.com
    docBaseUrl:  process.env.CHI_DOC_BASE_URL  || 'https://ix-uat.careinsurance.com',
    docUsername: process.env.CHI_DOC_USERNAME  || '',
    docPassword: process.env.CHI_DOC_PASSWORD  || '',

    // CKYC
    partnerCode: process.env.CHI_PARTNER_CODE || '',
    publicKey:   process.env.CHI_PUBLIC_KEY   || '',
  },
};
