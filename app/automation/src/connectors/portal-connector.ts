/**
 * Portal connector — wraps the existing Playwright playbook runner.
 * Used by any insurer whose integration is browser-based (UIIC, etc.).
 *
 * One instance per insurer_id. Constructed with just the portal ID;
 * the playbook JSON lives at portal/playbooks/<id>.json.
 */

import { runPlaybook, loadPlaybook, CaptchaRequiredError } from '../portal/playbook-runner';
import type { InsuranceConnector, ConnectorOptions, ConnectorQuoteResult } from './types';

export class PortalConnector implements InsuranceConnector {
  readonly type = 'portal' as const;

  constructor(readonly insurer_id: string) {}

  async getQuote(
    fields:    Record<string, string>,
    sessionId: string,
    userId:    string,
    userEmail: string,
    options:   ConnectorOptions = {},
  ): Promise<ConnectorQuoteResult> {
    const { browserContext, onProgress, captchaText, debugMode, skipLogin } = options;

    if (!browserContext) {
      return {
        success: false, premium: null, idv: null, quoteRef: null,
        rawData: {}, durationMs: 0,
        errorMessage: `Portal connector for "${this.insurer_id}" requires a browser context`,
      };
    }

    const playbook    = loadPlaybook(this.insurer_id);
    const hasBuyFlow  = !!playbook.buy_flow;

    try {
      const result = await runPlaybook(
        this.insurer_id,
        fields,
        browserContext,
        sessionId,
        userId,
        userEmail,
        captchaText,
        debugMode,
        onProgress,
        hasBuyFlow,
        skipLogin,
      );

      return result as ConnectorQuoteResult;
    } catch (err: any) {
      if (err instanceof CaptchaRequiredError) {
        return {
          success: false, premium: null, idv: null, quoteRef: null,
          rawData: {}, durationMs: 0,
          errorMessage:        err.message,
          captchaRequired:     true,
          captchaImageBase64:  err.captchaImageBase64,
        };
      }
      throw err;
    }
  }
}
