/**
 * Langfuse v3 SDK wrapper — uses plain HTTP (no OpenTelemetry).
 * @langfuse/tracing (v5) was removed because its OTel auto-instrumentation
 * patches Node.js HTTP internals and strips auth headers from the Anthropic SDK.
 *
 * Exported:
 *   getLangfuse()     — singleton client, null when keys are absent
 *   tracingEnabled    — boolean flag for startup log + shutdown guard
 */
import Langfuse from 'langfuse';
import { config } from '../config/env';

let _lf: Langfuse | null = null;

export function getLangfuse(): Langfuse | null {
  if (!config.langfuse.publicKey || !config.langfuse.secretKey) return null;
  if (!_lf) {
    _lf = new Langfuse({
      publicKey: config.langfuse.publicKey,
      secretKey: config.langfuse.secretKey,
      baseUrl:   config.langfuse.baseUrl,
      flushInterval: 5000,
      flushAt:       20,
    });
  }
  return _lf;
}

export const tracingEnabled = !!(
  process.env.LANGFUSE_PUBLIC_KEY &&
  process.env.LANGFUSE_SECRET_KEY
);

/** Call on graceful shutdown to flush any queued events. */
export async function shutdownLangfuse(): Promise<void> {
  if (_lf) {
    try { await _lf.shutdownAsync(); } catch { /* best-effort */ }
  }
}
