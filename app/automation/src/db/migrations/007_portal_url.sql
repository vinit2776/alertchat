-- Add portal_url to insurance_companies for display in Insurance Connections UI
ALTER TABLE insurance_companies ADD COLUMN IF NOT EXISTS portal_url TEXT NOT NULL DEFAULT '';

-- Seed known portal login URLs
UPDATE insurance_companies SET portal_url = 'https://nysa.icicilombard.com/#/login'                                   WHERE id = 'icici_motor'    AND portal_url = '';
UPDATE insurance_companies SET portal_url = 'https://orientalinsurance.org.in/'                                       WHERE id = 'oriental_motor' AND portal_url = '';
UPDATE insurance_companies SET portal_url = 'https://www.uiic.in/GCWebPortal/login/LoginAction.do?p=login'           WHERE id = 'uiic'           AND portal_url = '';
