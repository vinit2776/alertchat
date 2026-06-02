/**
 * Langfuse v5 (@langfuse/tracing) auto-initialises from env vars:
 *   LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL
 *
 * Re-export the three primitives used across this service so import paths
 * stay stable if the underlying package ever changes.
 */
export {
  startActiveObservation,
  startObservation,
  propagateAttributes,
  getLangfuseTracerProvider,
} from '@langfuse/tracing';

export const tracingEnabled = !!(
  process.env.LANGFUSE_PUBLIC_KEY &&
  process.env.LANGFUSE_SECRET_KEY
);
