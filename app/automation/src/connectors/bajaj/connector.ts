/**
 * Bajaj Allianz General Insurance — API connector.
 *
 * Implements InsuranceConnector for Bajaj's REST API.
 * No browser pool slot is consumed — this is a pure API call.
 *
 * Flow (Agent Float mode):
 *   1. Map normalised fields → Bajaj payload  (field-mapper)
 *   2. Validate vehicle code exists in cache    (vehicle-master)
 *   3. POST calculateMotorPremiumSig            (client)
 *   4. Return ConnectorQuoteResult with transactionId as quoteRef
 *
 * The issuePolicy step is separate — triggered by the buy flow after user
 * confirms the quote. The transactionId from step 3 is stored in quoteRef
 * and passed back when proceeding.
 */

import { config } from '../../config/env';
import { logEvent } from '../../audit/logger';
import { calculatePremium } from './client';
import { mapToBajajPayload } from './field-mapper';
import { getCacheStatus } from './vehicle-master';
import type { InsuranceConnector, ConnectorOptions, ConnectorQuoteResult } from '../types';

export class BajajConnector implements InsuranceConnector {
  readonly insurer_id = 'bajaj';
  readonly type       = 'api' as const;

  async getQuote(
    fields:    Record<string, string>,
    sessionId: string,
    userId:    string,
    userEmail: string,
    options:   ConnectorOptions = {},
  ): Promise<ConnectorQuoteResult> {
    const { onProgress } = options;
    const startMs = Date.now();

    const emit = (msg: string) => {
      onProgress?.({ type: 'step', portalId: 'bajaj', portalName: 'Bajaj Allianz', message: msg, ts: Date.now() });
    };

    // ── Credential check ──────────────────────────────────────────────────
    if (!config.bajaj.userId || !config.bajaj.password) {
      return this.failure(
        'Bajaj API credentials not configured. Set BAJAJ_USER_ID and BAJAJ_PASSWORD in .env',
        startMs,
        sessionId, userId, userEmail,
      );
    }

    try {
      emit('Mapping vehicle details…');

      // ── Field mapping ─────────────────────────────────────────────────────
      const { vehiclecode, city, weomotpolicyin, motextracover, warnings } =
        mapToBajajPayload(fields);

      if (warnings.length) {
        warnings.forEach(w => emit(`⚠ ${w}`));
      }

      // ── Vehicle code check ────────────────────────────────────────────────
      if (!vehiclecode) {
        const cache = getCacheStatus();
        const cacheMsg = cache.entryCount === 0
          ? 'Vehicle master cache is empty — credentials received, run /api/admin/bajaj/refresh-vehicles to populate.'
          : `No matching vehicle found in Bajaj master cache (${cache.entryCount} entries, last refreshed ${cache.refreshedAt}). ` +
            'Check that make/model/subtype match exactly or refresh the cache.';

        return this.failure(cacheMsg, startMs, sessionId, userId, userEmail);
      }

      // ── API call ──────────────────────────────────────────────────────────
      emit(`Calling Bajaj API — vehicle code ${vehiclecode}, city ${city}…`);

      const response = await calculatePremium({
        vehiclecode,
        city,
        weomotpolicyin,
        motextracover,
        transactionid: 0,
      });

      const pd         = response.premiumdetails;
      const premium    = pd?.totalpremium  ?? null;
      const idv        = pd?.vehicleidv    ?? null;
      const odPremium  = pd?.odpremium     ?? null;
      const tpPremium  = pd?.tppremium     ?? null;
      const ncbAmount  = pd?.ncbamount     ?? null;
      const gst        = pd?.servicetaxamount ?? null;
      const transactionId = response.transactionid;

      emit(`✓ Premium computed — ₹${premium?.toLocaleString('en-IN') ?? '?'} (transactionId: ${transactionId})`);

      logEvent({
        userId, userEmail, sessionId,
        portalId: 'bajaj',
        action:   'quote_generated',
        outcome:  'success',
        durationMs: Date.now() - startMs,
        meta: { premium, idv, transactionId },
      });

      return {
        success:    true,
        premium,
        idv,
        odPremium,
        tpPremium,
        ncbAmount,
        gst,
        quoteRef:   String(transactionId),
        rawData:    response as unknown as Record<string, unknown>,
        errorMessage: null,
        durationMs: Date.now() - startMs,
      };

    } catch (err: any) {
      emit(`✗ Bajaj API error: ${err.message}`);

      logEvent({
        userId, userEmail, sessionId,
        portalId: 'bajaj',
        action:   'quote_failed',
        outcome:  'failure',
        durationMs: Date.now() - startMs,
        meta: { error: err.message },
      });

      return this.failure(err.message, startMs, sessionId, userId, userEmail);
    }
  }

  private failure(
    message: string,
    startMs: number,
    sessionId: string,
    userId:    string,
    userEmail: string,
  ): ConnectorQuoteResult {
    logEvent({
      userId, userEmail, sessionId,
      portalId: 'bajaj', action: 'quote_failed', outcome: 'failure',
      durationMs: Date.now() - startMs,
      meta: { error: message },
    });
    return {
      success: false, premium: null, idv: null, quoteRef: null,
      rawData: {}, durationMs: Date.now() - startMs,
      errorMessage: message,
    };
  }
}
