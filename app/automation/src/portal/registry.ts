import { query, queryOne } from '../db/client';
import { InsuranceCompany, InsuranceType } from '../types';
import { listAvailablePlaybooks } from './playbook-runner';

// ── Static API-based companies (no playbook file, no browser needed) ─────────
// These are registered here so they appear in the management UI even when
// the DB is empty. Credentials are configured via env vars, not the vault.
const STATIC_API_COMPANIES: InsuranceCompany[] = (() => {
  const now = new Date().toISOString();
  return [
    {
      id:                  'bajaj',
      name:                'Bajaj Allianz General Insurance',
      logoUrl:             '',
      portalUrl:           '',
      insuranceTypes:      ['motor'] as InsuranceType[],
      playbookVersion:     'api-v1',
      enabled:             false,  // disabled until credentials are configured in .env
      credentialSecretKey: 'bajaj_api_creds',
      lastTestedAt:        null,
      createdAt:           now,
      updatedAt:           now,
    },
  ];
})();

// ── In-memory fallback (no DATABASE_URL) ─────────────────────────────────────
// Combines playbook-based portal companies with static API companies.
function getStaticCompanies(): InsuranceCompany[] {
  const now = new Date().toISOString();
  const portalCompanies = listAvailablePlaybooks()
    .filter(id => !id.startsWith('_'))
    .map(id => ({
      id,
      name:                id.toUpperCase().replace(/_/g, ' '),
      logoUrl:             '',
      portalUrl:           '',
      insuranceTypes:      ['motor'] as InsuranceType[],
      playbookVersion:     '1.0',
      enabled:             true,
      credentialSecretKey: `${id}_creds`,
      lastTestedAt:        null,
      createdAt:           now,
      updatedAt:           now,
    }));
  // Merge: DB API companies fill gaps not covered by playbooks
  const portalIds = new Set(portalCompanies.map(c => c.id));
  const apiOnly   = STATIC_API_COMPANIES.filter(c => !portalIds.has(c.id));
  return [...portalCompanies, ...apiOnly];
}

export async function getEnabledCompanies(insuranceType?: InsuranceType): Promise<InsuranceCompany[]> {
  const rows = await query<any>(
    `SELECT * FROM insurance_companies WHERE enabled = true
     ${insuranceType ? 'AND $1 = ANY(insurance_types)' : ''}
     ORDER BY name`,
    insuranceType ? [insuranceType] : undefined
  );
  if (rows.length === 0 && !process.env.DATABASE_URL) {
    const all = getStaticCompanies();
    return insuranceType ? all.filter(c => c.insuranceTypes.includes(insuranceType)) : all;
  }
  return rows.map(rowToCompany);
}

export async function getAllCompanies(): Promise<InsuranceCompany[]> {
  const rows = await query<any>('SELECT * FROM insurance_companies ORDER BY name');
  if (rows.length === 0 && !process.env.DATABASE_URL) return getStaticCompanies();
  return rows.map(rowToCompany);
}

export async function getCompanyById(id: string): Promise<InsuranceCompany | null> {
  const row = await queryOne<any>('SELECT * FROM insurance_companies WHERE id = $1', [id]);
  if (!row && !process.env.DATABASE_URL) {
    return getStaticCompanies().find(c => c.id === id) ?? null;
  }
  return row ? rowToCompany(row) : null;
}

export async function setEnabled(id: string, enabled: boolean): Promise<InsuranceCompany | null> {
  const row = await queryOne<any>(
    `UPDATE insurance_companies SET enabled = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [enabled, id]
  );
  return row ? rowToCompany(row) : null;
}

export async function updateLastTested(id: string, success: boolean): Promise<void> {
  await query(
    `UPDATE insurance_companies SET last_tested_at = now(), updated_at = now() WHERE id = $1`,
    [id]
  );
}

export async function upsertCompany(company: Partial<InsuranceCompany> & { id: string }): Promise<InsuranceCompany> {
  const row = await queryOne<any>(
    `INSERT INTO insurance_companies
       (id, name, logo_url, portal_url, insurance_types, playbook_version, enabled, credential_secret_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET
       name                 = EXCLUDED.name,
       logo_url             = EXCLUDED.logo_url,
       portal_url           = EXCLUDED.portal_url,
       insurance_types      = EXCLUDED.insurance_types,
       playbook_version     = EXCLUDED.playbook_version,
       enabled              = EXCLUDED.enabled,
       credential_secret_key = EXCLUDED.credential_secret_key,
       updated_at           = now()
     RETURNING *`,
    [
      company.id,
      company.name ?? '',
      company.logoUrl ?? '',
      company.portalUrl ?? '',
      company.insuranceTypes ?? [],
      company.playbookVersion ?? '1.0',
      company.enabled ?? false,
      company.credentialSecretKey ?? '',
    ]
  );
  return rowToCompany(row!);
}

function rowToCompany(row: any): InsuranceCompany {
  return {
    id:                  row.id,
    name:                row.name,
    logoUrl:             row.logo_url,
    portalUrl:           row.portal_url ?? '',
    insuranceTypes:      row.insurance_types,
    playbookVersion:     row.playbook_version,
    enabled:             row.enabled,
    credentialSecretKey: row.credential_secret_key,
    lastTestedAt:        row.last_tested_at?.toISOString() ?? null,
    createdAt:           row.created_at.toISOString(),
    updatedAt:           row.updated_at.toISOString(),
  };
}
