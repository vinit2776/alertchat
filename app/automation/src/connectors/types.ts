/**
 * Common connector interface for all insurance companies.
 *
 * Insurers are connected in two ways:
 *   'portal'  — Playwright browser automation fills the insurer's web portal
 *   'api'     — Direct REST/SOAP API calls (faster, no browser slot needed)
 *
 * The quote.routes.ts orchestrator calls getQuote() on each connector and
 * only acquires a browser pool slot when connector.type === 'portal'.
 *
 * To add a new insurer:
 *   1. Create src/connectors/<id>/connector.ts implementing InsuranceConnector
 *   2. Register it in src/connectors/registry.ts
 *   3. Add portal/knowledge/<id>/requirements.json
 */

import type { BrowserContext } from 'playwright';
import type { ProgressEvent }  from '../session/progress';

// ── Result types ─────────────────────────────────────────────────────────────

export interface ConnectorQuoteResult {
  success:             boolean;
  premium:             number | null;    // total premium including GST, in ₹
  idv:                 number | null;    // IDV in ₹
  odPremium?:          number | null;
  tpPremium?:          number | null;
  ncbAmount?:          number | null;
  gst?:                number | null;
  quoteRef:            string | null;    // API: transactionId, Portal: quote page ref
  rawData:             Record<string, unknown>;
  errorMessage:        string | null;
  durationMs:          number;

  // Portal-specific only
  screenshotBase64?:   string;
  captchaRequired?:    boolean;
  captchaImageBase64?: string;
  resumeState?:        { storageState: unknown; resumeUrl: string };
}

// ── Options passed to getQuote ───────────────────────────────────────────────

export interface ConnectorOptions {
  /** Only provided for portal connectors — the Playwright browser context */
  browserContext?: BrowserContext;

  /** Emit real-time progress events to the SSE stream */
  onProgress?: (event: ProgressEvent) => void;

  /** Captcha solution text for portal connectors that encounter a captcha */
  captchaText?: string;

  /** Set true to pause automation for visual debugging */
  debugMode?: boolean;

  /** When true, skip the portal login step — context already has a captured session */
  skipLogin?: boolean;
}

// ── Main interface ────────────────────────────────────────────────────────────

export interface InsuranceConnector {
  /** Portal ID matching InsuranceCompany.id in the registry */
  readonly insurer_id: string;

  /** 'portal' connectors use the browser pool; 'api' connectors don't */
  readonly type: 'portal' | 'api';

  /**
   * Run a quote for the given normalised + computed fields.
   * Fields are the output of computeMotorFields() — all computed.* keys present.
   */
  getQuote(
    fields:     Record<string, string>,
    sessionId:  string,
    userId:     string,
    userEmail:  string,
    options?:   ConnectorOptions,
  ): Promise<ConnectorQuoteResult>;
}
