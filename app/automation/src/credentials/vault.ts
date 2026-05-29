// Credential vault — fetches portal login credentials securely.
// Production: reads from AWS Secrets Manager.
// Development: reads from env var PORTAL_CREDS_<PORTAL_ID> (base64-encoded JSON).

export interface PortalCredentials {
  username:    string;
  password:    string;
  agentCode?:  string;
  branchCode?: string;
}

export async function getCredentials(portalId: string): Promise<PortalCredentials> {
  // Try AWS Secrets Manager first if configured
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return fetchFromSecretsManager(portalId);
  }

  // Dev fallback: env var PORTAL_CREDS_<PORTAL_ID> = base64(JSON)
  const envKey = `PORTAL_CREDS_${portalId.toUpperCase().replace(/-/g, '_')}`;
  const raw    = process.env[envKey];
  if (raw) {
    try {
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as PortalCredentials;
    } catch {
      throw new Error(`Invalid base64 JSON in ${envKey}`);
    }
  }

  throw new Error(`No credentials configured for portal: ${portalId}. Set ${envKey} env var or configure AWS Secrets Manager.`);
}

async function fetchFromSecretsManager(portalId: string): Promise<PortalCredentials> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const awsSdk = require('@aws-sdk/client-secrets-manager') as {
    SecretsManagerClient: any;
    GetSecretValueCommand: any;
  };

  const client = new awsSdk.SecretsManagerClient({
    region: process.env.AWS_REGION || 'ap-south-1',
  });

  const cmd = new awsSdk.GetSecretValueCommand({ SecretId: `alert-insurance/${portalId}` });
  const res  = await client.send(cmd);

  if (!res.SecretString) {
    throw new Error(`Secret for ${portalId} has no string value`);
  }

  return JSON.parse(res.SecretString) as PortalCredentials;
}
