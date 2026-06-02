import { Browser, BrowserContext, chromium } from 'playwright';

const POOL_SIZE    = 15;
const SESSION_TTL  = 30 * 60 * 1000; // 30 minutes

interface Slot {
  id:         number;
  context:    BrowserContext | null;
  sessionKey: string | null;   // format: "sessionId:portalId"
  assignedAt: number;
}

class BrowserPool {
  private browser: Browser | null = null;
  private slots: Slot[] = Array.from({ length: POOL_SIZE }, (_, i) => ({
    id: i, context: null, sessionKey: null, assignedAt: 0,
  }));

  private async getBrowser(): Promise<Browser> {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
    }
    return this.browser;
  }

  async acquire(
    sessionKey:    string,
    storageState?: unknown,   // optional — restore cookies + localStorage from a prior quote
  ): Promise<{ slotId: number; context: BrowserContext }> {
    await this.releaseStale();

    const slot = this.slots.find(s => s.sessionKey === null);
    if (!slot) throw new Error('Browser pool exhausted — all 15 contexts are in use. Please try again shortly.');

    const browser  = await this.getBrowser();
    const context  = await browser.newContext({
      viewport:    { width: 1280, height: 800 },
      userAgent:   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale:      'en-IN',
      timezoneId:  'Asia/Kolkata',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(storageState ? { storageState: storageState as any } : {}),
    });

    slot.context    = context;
    slot.sessionKey = sessionKey;
    slot.assignedAt = Date.now();

    return { slotId: slot.id, context };
  }

  async release(sessionKey: string): Promise<void> {
    const slot = this.slots.find(s => s.sessionKey === sessionKey);
    if (!slot) return;

    if (slot.context) {
      try { await slot.context.close(); } catch { /* ignore */ }
      slot.context = null;
    }
    slot.sessionKey = null;
    slot.assignedAt = 0;
  }

  private async releaseStale(): Promise<void> {
    const now = Date.now();
    for (const slot of this.slots) {
      if (slot.sessionKey && (now - slot.assignedAt) > SESSION_TTL) {
        console.warn(`[Pool] Releasing stale slot ${slot.id} (key: ${slot.sessionKey})`);
        await this.release(slot.sessionKey);
      }
    }
  }

  /** Return the context for an already-acquired session (for captcha phase 2). */
  lookup(sessionKey: string): BrowserContext | null {
    return this.slots.find(s => s.sessionKey === sessionKey)?.context ?? null;
  }

  freeSlots():  number { return this.slots.filter(s => s.sessionKey === null).length; }
  usedSlots():  number { return this.slots.filter(s => s.sessionKey !== null).length; }

  status() {
    return {
      total:    POOL_SIZE,
      free:     this.freeSlots(),
      used:     this.usedSlots(),
      sessions: this.slots.filter(s => s.sessionKey).map(s => ({
        slotId: s.id, sessionKey: s.sessionKey, ageMs: Date.now() - s.assignedAt,
      })),
    };
  }

  async shutdown(): Promise<void> {
    for (const slot of this.slots) {
      if (slot.context) {
        try { await slot.context.close(); } catch { /* ignore */ }
        slot.context = null;
        slot.sessionKey = null;
      }
    }
    if (this.browser) {
      try { await this.browser.close(); } catch { /* ignore */ }
      this.browser = null;
    }
  }
}

export const browserPool = new BrowserPool();
