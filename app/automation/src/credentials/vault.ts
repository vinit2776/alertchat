// Credential vault — fetches portal login credentials securely.
// Priority: DB vault (admin UI) → env var PORTAL_CREDS_<ID> → AWS Secrets Manager.

export interface PortalCredentials {
  username:    string;
  password:    string;
  agentCode?:  string;
  branchCode?: string;
}

export async function getCredentials(portalId: string): Promise<PortalCredentials> {
  // 1. DB vault (set via admin UI)
  if (process.env.DATABASE_URL) {
    try {
      const { loadCredentials } = await import('./db-vault');
      const dbCreds = await loadCredentials(portalId);
      if (dbCreds) return dbCreds;
    } catch {
      // DB not available — fall through
    }
  }

  // 2. Env var fallback: PORTAL_CREDS_<PORTAL_ID> = base64(JSON)
  const envKey = `PORTAL_CREDS_${portalId.toUpperCase().replace(/-/g, '_')}`;
  const raw    = process.env[envKey];
  if (raw) {
    try {
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as PortalCredentials;
    } catch {
      throw new Error(`Invalid base64 JSON in ${envKey}`);
    }
  }

  // 3. AWS Secrets Manager
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return fetchFromSecretsManager(portalId);
  }

  throw new Error(
    `No credentials configured for portal: ${portalId}. ` +
    `Set them via the admin UI or set ${envKey} env var.`,
  );
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
