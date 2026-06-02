import { EventEmitter } from 'events';

// ── Progress event types ────────────────────────────────────────────────────

export interface ProgressEvent {
  type:       'login' | 'step' | 'result' | 'error' | 'quote_complete' | 'all_complete' | 'captcha_required'
            // Cookie handoff flow events (channel key = `handoff:<handoffId>`)
            | 'handoff_waiting' | 'cookies_received' | 'replay_started' | 'replay_step'
            | 'replay_complete' | 'replay_failed' | 'session_expired';
  portalId:   string;
  portalName: string;
  message:    string;
  ts:         number;
  /** Only on type=result — headline figures */
  data?:      { premium?: number | null; idv?: number | null };
  /** Only on type=quote_complete | replay_complete — full quote result */
  result?:    Record<string, unknown>;
  /** Only on type=cookies_received — how many cookies were captured */
  cookieCount?: number;
}

// ── Per-session EventEmitter store ─────────────────────────────────────────

const emitters = new Map<string, EventEmitter>();

function getOrCreate(sessionId: string): EventEmitter {
  if (!emitters.has(sessionId)) {
    const e = new EventEmitter();
    e.setMaxListeners(25);   // 1 SSE listener + up to 15 portal workers
    emitters.set(sessionId, e);
  }
  return emitters.get(sessionId)!;
}

/** Emit a progress event to all listeners for this session */
export function emitProgress(sessionId: string, event: ProgressEvent): void {
  emitters.get(sessionId)?.emit('progress', event);
}

/** Subscribe to progress events for a session */
export function onProgress(
  sessionId: string,
  handler:   (e: ProgressEvent) => void,
): void {
  getOrCreate(sessionId).on('progress', handler);
}

/** Unsubscribe a specific handler */
export function offProgress(
  sessionId: string,
  handler:   (e: ProgressEvent) => void,
): void {
  emitters.get(sessionId)?.off('progress', handler);
}

/** Remove all listeners and delete the emitter for this session */
export function cleanupProgress(sessionId: string): void {
  const e = emitters.get(sessionId);
  if (e) {
    e.removeAllListeners();
    emitters.delete(sessionId);
  }
}
