-- Add portal_url to insurance_companies for display in Insurance Connections UI
ALTER TABLE insurance_companies ADD COLUMN IF NOT EXISTS portal_url TEXT NOT NULL DEFAULT '';

-- Insert Oriental Insurance (added after initial seed — not in 001_init.sql)
INSERT INTO insurance_companies (id, name, logo_url, portal_url, insurance_types, playbook_version, enabled, credential_secret_key)
VALUES ('oriental_motor', 'Oriental Insurance Company Limited', '', 'https://orientalinsurance.org.in/', ARRAY['motor'], '1.0', true, 'oriental_motor_creds')
ON CONFLICT (id) DO UPDATE SET
  name       = EXCLUDED.name,
  portal_url = EXCLUDED.portal_url,
  enabled    = EXCLUDED.enabled,
  updated_at = now();

-- Enable ICICI Lombard (seeded as disabled in 001_init.sql)
UPDATE insurance_companies SET enabled = true WHERE id = 'icici_motor';

-- Set portal login URLs for companies already in the seed
UPDATE insurance_companies SET portal_url = 'https://nysa.icicilombard.com/#/login'                         WHERE id = 'icici_motor'    AND portal_url = '';
UPDATE insurance_companies SET portal_url = 'https://www.uiic.in/GCWebPortal/login/LoginAction.do?p=login' WHERE id = 'uiic'           AND portal_url = '';
