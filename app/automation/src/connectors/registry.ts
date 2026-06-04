/**
 * Connector registry — maps insurer_id → InsuranceConnector instance.
 *
 * Every insurer is registered here exactly once at startup.
 * quote.routes.ts calls getConnector(id) instead of hard-coding runPlaybook().
 *
 * Connector types:
 *   PortalConnector  — Playwright browser automation (UIIC, etc.)
 *   BajajConnector   — Bajaj Allianz REST API (no browser needed)
 *
 * To add a new insurer:
 *   1. If API-based:   create src/connectors/<id>/connector.ts, register below
 *   2. If portal-based: add portal/playbooks/<id>.json, register as PortalConnector
 */

import { PortalConnector } from './portal-connector';
import { BajajConnector }  from './bajaj/connector';
import type { InsuranceConnector } from './types';

// ── Registry ─────────────────────────────────────────────────────────────────

const _registry = new Map<string, InsuranceConnector>();

function register(connector: InsuranceConnector): void {
  _registry.set(connector.insurer_id, connector);
}

// ── Register all connectors ───────────────────────────────────────────────────

// Portal-based (browser automation)
register(new PortalConnector('uiic'));

// API-based
register(new BajajConnector());

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get the connector for an insurer.
 * Falls back to PortalConnector for unknown IDs (safe default — if there's
 * a playbook file, the portal runner will handle it).
 */
export function getConnector(insurer_id: string): InsuranceConnector {
  return _registry.get(insurer_id) ?? new PortalConnector(insurer_id);
}

export function getAllConnectors(): InsuranceConnector[] {
  return Array.from(_registry.values());
}

export function getConnectorType(insurer_id: string): 'portal' | 'api' {
  return _registry.get(insurer_id)?.type ?? 'portal';
}
