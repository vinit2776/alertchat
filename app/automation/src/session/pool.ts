import { Browser, BrowserContext, chromium } from 'playwright';

const POOL_SIZE    = 3;  // Reduced from 15 — each Chromium context uses ~150-200MB on Railway
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
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          // Anti-bot: hide headless markers
          '--disable-blink-features=AutomationControlled',
          // Memory footprint reduction for Railway containers (~512MB limit)
          '--disable-gpu',
          '--disable-background-networking',
          '--disable-extensions',
          '--disable-sync',
          '--disable-translate',
          '--hide-scrollbars',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-first-run',
          '--safebrowsing-disable-auto-update',
          '--js-flags=--max-old-space-size=256',
          // Single-process: renderer runs in browser process — saves ~100MB per context
          '--single-process',
          // Limit tab/renderer count
          '--renderer-process-limit=1',
        ],
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
      // Match the actual Playwright-bundled Chromium version to avoid mismatch detection
      userAgent:   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale:      'en-IN',
      timezoneId:  'Asia/Kolkata',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(storageState ? { storageState: storageState as any } : {}),
    });

    // Spoof navigator.webdriver = undefined so bot-detection scripts see a normal browser
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).chrome = { runtime: {} };
    });

    // Block images, fonts and media to keep Chromium within Railway's RAM budget.
    // Some portals' JS checks for loaded images — those are handled by allowing
    // the request to fail gracefully (abort returns a network error, not a 4xx).
    await context.route('**/*', route => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'font' || type === 'media') {
        route.abort();
      } else {
        route.continue();
      }
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
