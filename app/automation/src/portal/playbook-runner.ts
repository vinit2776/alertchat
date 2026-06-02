import { BrowserContext, Page } from 'playwright';
import * as fs   from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { logEvent } from '../audit/logger';
import { getCredentials } from '../credentials/vault';
import { config } from '../config/env';
import type { ProgressEvent } from '../session/progress';
import { getLangfuse } from '../ai/langfuse-client';

let _anthropic: Anthropic | null = null;
function getAI(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic(config.anthropicApiKey ? { apiKey: config.anthropicApiKey } : {});
  return _anthropic;
}

// ── Playbook schema ────────────────────────────────────────────────────────

export interface PlaybookField {
  name:      string;
  selector:  string;
  // e.g. "rc.registration_number", "chat.ncb_percentage", or just "field_name"
  source:    string;
  type:      'text' | 'select' | 'radio' | 'checkbox' | 'date';
  // optional mapping from human-readable value to portal-specific value
  valueMap?: Record<string, string>;
  optional?: boolean;
}

export interface PlaybookStep {
  step_id:        string;
  label:          string;
  fields:         PlaybookField[];
  next_trigger?:  { selector: string; action: 'click' | 'submit' };
  wait_after?:    string;
  delay_ms?:      number;
  // If set, navigate to base_url + navigate_url before filling fields
  navigate_url?:  string;
}

export interface ExcludedCondition {
  // Field name (without namespace prefix, e.g. "is_electric" not "computed.is_electric")
  field:   string;
  // Value to match, case-insensitive exact match
  value:   string;
  // Human-readable explanation returned in errorMessage
  message: string;
}

export interface PortalPlaybook {
  portal_id:      string;
  name:           string;
  base_url:       string;
  insurance_type: string;
  // Pre-flight checks — if any condition matches the confirmed fields, the runner
  // returns an error immediately without opening a browser session.
  excluded_conditions?: ExcludedCondition[];
  login: {
    url:               string;
    username_field:    string;
    password_field:    string;
    submit:            string;
    success_indicator: string;
    // Selectors of close/dismiss buttons to click before interacting with the form
    // (handles portals that show announcement modals or PWA prompts on load)
    dismiss_modals?:   string[];
    captcha?: {
      image_selector:  string;
      input_selector:  string;
    };
    otp_field?:        string;
  };
  quote_flow: PlaybookStep[];
  quote_result: {
    premium_selector?:       string;
    idv_selector?:           string;
    result_page_indicator?:  string;  // wait for this before extracting
    full_page_screenshot:    boolean;
    // Optional richer fields. Selectors are best-effort — set to null if not present.
    od_premium_selector?:        string;
    tp_premium_selector?:        string;
    gst_selector?:               string;
    ncb_amount_selector?:        string;
    addon_zero_dep_selector?:    string;
    addon_engine_protect_selector?: string;
    addon_rsa_selector?:         string;
    addon_pa_selector?:          string;
    cashless_count_selector?:    string;
    quote_ref_selector?:         string;
  };
  // Optional buy flow — runs after the agent clicks "Get Payment Link" on a quote.
  // The session's Playwright page stays alive after the quote, so these steps
  // execute in the same browser context. Final step should capture the payment URL.
  buy_flow?: {
    steps:               PlaybookStep[];
    payment_url_extractor: {
      strategy: 'current_url' | 'href' | 'text';
      // For href/text strategies, the selector to read from
      selector?: string;
      // Regex to extract the URL from the captured value (optional)
      url_regex?: string;
    };
    confirmation_number_selector?: string;
    policy_pdf_link_selector?:     string;
  };
}

export interface QuoteRunResult {
  portalId:         string;
  portalName:       string;
  success:          boolean;
  premium:          number | null;
  idv:              number | null;
  screenshotBase64: string | null;
  rawData:          Record<string, string>;
  errorMessage:     string | null;
  durationMs:       number;
  // Expanded breakdown (any of these may be null if the portal doesn't show them)
  odPremium?:       number | null;
  tpPremium?:       number | null;
  gstAmount?:       number | null;
  ncbAmount?:       number | null;
  addonZeroDep?:    number | null;
  addonEngine?:     number | null;
  addonRsa?:        number | null;
  addonPa?:         number | null;
  cashlessCount?:   number | null;
  quoteRef?:        string | null;
  // True if the playbook has a buy_flow — the frontend should show "Get Payment Link"
  supportsProceed?: boolean;
}

// ── Playbook loader ────────────────────────────────────────────────────────

const PLAYBOOK_DIR = path.join(__dirname, 'playbooks');

export function loadPlaybook(portalId: string): PortalPlaybook {
  const file = path.join(PLAYBOOK_DIR, `${portalId}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`No playbook found for portal: ${portalId}. Create src/portal/playbooks/${portalId}.json`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as PortalPlaybook;
}

export function listAvailablePlaybooks(): string[] {
  if (!fs.existsSync(PLAYBOOK_DIR)) return [];
  return fs.readdirSync(PLAYBOOK_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));
}

// ── Field resolution ───────────────────────────────────────────────────────

function resolveValue(source: string, fields: Record<string, string>): string | null {
  const key = source.includes('.') ? source.split('.').slice(1).join('.') : source;
  return fields[key] ?? null;
}

// ── Captcha errors ────────────────────────────────────────────────────────

export class CaptchaRequiredError extends Error {
  readonly captchaImageBase64: string;
  constructor(imageBase64: string) {
    super('Captcha required — AI solving failed. Provide captchaText to retry.');
    this.name = 'CaptchaRequiredError';
    this.captchaImageBase64 = imageBase64;
  }
}

// ── Captcha solver ────────────────────────────────────────────────────────

async function solveCaptcha(page: Page, imgSelector: string): Promise<string> {
  const el  = page.locator(imgSelector).first();
  const buf = await el.screenshot();

  const CAPTCHA_MODEL = 'claude-haiku-4-5-20251001';

  const lf  = getLangfuse();
  const gen = lf?.trace({ name: 'captcha-solve', tags: ['captcha'] })
    .generation({ name: 'captcha-solve', model: CAPTCHA_MODEL, input: 'captcha image' });

  const response = await getAI().messages.create({
    model:      CAPTCHA_MODEL,
    max_tokens: 32,
    messages: [{
      role:    'user',
      content: [{
        type:   'image',
        source: { type: 'base64', media_type: 'image/png', data: buf.toString('base64') },
      }, {
        type: 'text',
        text: 'This is a CAPTCHA image from an insurance portal login page. Read the characters shown and return ONLY the captcha text, no other words.',
      }],
    }],
  });

  const text = (response.content.find(b => b.type === 'text')?.text ?? '')
    .trim().replace(/\s+/g, '');

  // Captcha text intentionally hidden from traces
  gen?.end({
    output: '(redacted)',
    usage:  { input: response.usage.input_tokens, output: response.usage.output_tokens, unit: 'TOKENS' },
  });

  console.log(`[Captcha] Solved: "${text}"`);
  return text;
}

// ── Main runner ────────────────────────────────────────────────────────────

export async function runPlaybook(
  portalId:        string,
  confirmedFields: Record<string, string>,
  context:         BrowserContext,
  sessionId:       string,
  userId:          string,
  userEmail:       string,
  captchaText?:    string,   // human-provided captcha (skip AI if set)
  debugMode?:      boolean,  // if true: save per-step screenshots + log select options
  onProgress?:     (event: ProgressEvent) => void,  // real-time step callback for SSE
  extractResumeState?: boolean,  // if true: capture storage state + URL before closing page
): Promise<QuoteRunResult & {
  debugSteps?: Array<{ stepId: string; screenshotBase64: string; formHtml?: string }>;
  // Set only when extractResumeState=true: lets the buy flow resume in a fresh browser
  resumeState?: {
    storageState: unknown;  // Playwright StorageState
    resumeUrl:    string;
  };
}> {
  const start      = Date.now();
  const playbook   = loadPlaybook(portalId);
  let   page: Page | null = null;
  // Declared outside try so it survives into catch for debug returns
  const debugSteps: Array<{ stepId: string; screenshotBase64: string; formHtml?: string }> = [];

  // ── Pre-flight: excluded conditions ───────────────────────────────────────
  // Check before opening a browser — saves the pool slot and avoids a confusing
  // mid-form server error.
  if (playbook.excluded_conditions?.length) {
    for (const cond of playbook.excluded_conditions) {
      const fieldVal = (confirmedFields[cond.field] ?? '').toLowerCase();
      if (fieldVal === cond.value.toLowerCase()) {
        logEvent({
          userId, userEmail, sessionId, portalId,
          action: 'quote_failed', outcome: 'failure',
          durationMs: Date.now() - start,
          meta: { reason: 'excluded_condition', field: cond.field, value: cond.value },
        });
        return {
          portalId, portalName: playbook.name,
          success: false, premium: null, idv: null,
          screenshotBase64: null, rawData: {},
          errorMessage: cond.message, durationMs: Date.now() - start,
          ...(debugMode && { debugSteps }),
        };
      }
    }
  }

  try {
    page = await context.newPage();
    page.setDefaultTimeout(30_000);

    // ── Login ──────────────────────────────────────────────────────────────
    const loginUrl = playbook.base_url.replace(/\/$/, '') + playbook.login.url;
    // Use 'load' rather than 'networkidle' — 'networkidle' can hang on portals
    // that keep long-poll connections open, eventually closing the page context.
    await page.goto(loginUrl, { waitUntil: 'load', timeout: 30_000 });

    // Dismiss any announcement modals / PWA prompts that block the form.
    // Short 1s timeout per selector — if the page navigates during this loop
    // (some portals redirect after load), bail out gracefully.
    if (playbook.login.dismiss_modals?.length) {
      for (const sel of playbook.login.dismiss_modals) {
        try {
          await page.locator(sel).first().click({ timeout: 1_000 });
          await page.waitForTimeout(200);
        } catch {
          // Not found or page navigated — fine, move on
        }
        // Stop trying to dismiss if the page is gone
        if (!page.isClosed()) continue;
        break;
      }
    }

    // If the page navigated away during modal dismiss (some portals redirect),
    // navigate back to the login URL before trying to fill credentials.
    if (page.isClosed() || !page.url().includes(playbook.base_url.replace(/^https?:\/\//, ''))) {
      if (!page.isClosed()) {
        await page.goto(loginUrl, { waitUntil: 'load', timeout: 30_000 });
      }
    }

    const creds = await getCredentials(portalId);

    // Wait for the username field to be visible before clicking —
    // ensures the login form has fully rendered after any redirects.
    await page.locator(playbook.login.username_field).waitFor({ state: 'visible', timeout: 30_000 });

    // Click fields before filling — some portals (e.g. UIIC) have readonly="readonly"
    // removed only on focus; Playwright's fill() doesn't trigger focus by itself.
    await page.click(playbook.login.username_field);
    await page.fill(playbook.login.username_field, creds.username);
    await page.click(playbook.login.password_field);
    await page.fill(playbook.login.password_field, creds.password);

    // Solve image captcha if required by this portal.
    // Uses human-provided captchaText if set; otherwise tries AI once (no retries).
    if (playbook.login.captcha) {
      const { image_selector, input_selector } = playbook.login.captcha;
      await page.waitForSelector(image_selector, { timeout: 10_000 });

      const solved = captchaText ?? await solveCaptcha(page, image_selector);
      await page.fill(input_selector, solved);
    }

    await page.click(playbook.login.submit);

    const loginOk = await page.waitForSelector(playbook.login.success_indicator, { timeout: 20_000 })
      .then(() => true)
      .catch(() => false);

    if (!loginOk) {
      if (playbook.login.captcha) {
        const captchaStillPresent = await page.locator(playbook.login.captcha.image_selector)
          .isVisible({ timeout: 2_000 }).catch(() => false);

        if (!captchaStillPresent) {
          throw new Error(`Login appears successful but success_indicator "${playbook.login.success_indicator}" not found. Update the playbook.`);
        }

        // Captcha still on screen — login failed. Return image for human to read.
        const freshBuf = await page.locator(playbook.login.captcha.image_selector).first().screenshot()
          .catch(async () => page!.screenshot({ fullPage: false }));
        throw new CaptchaRequiredError(freshBuf.toString('base64'));
      }
      throw new Error('Login failed — success indicator not found after submit');
    }

    logEvent({
      userId, userEmail, sessionId, portalId,
      action: 'portal_login', outcome: 'success',
      durationMs: Date.now() - start,
    });
    onProgress?.({
      type: 'login', portalId, portalName: playbook.name,
      message: `✓ Logged in to ${playbook.name}`,
      ts: Date.now(),
    });

    // ── Quote flow ─────────────────────────────────────────────────────────
    for (const step of playbook.quote_flow) {
      const stepStart = Date.now();
      let filled = 0;

      onProgress?.({
        type: 'step', portalId, portalName: playbook.name,
        message: `→ ${step.label}…`,
        ts: Date.now(),
      });

      // Navigate first if this step has its own URL (e.g. direct link to calculator)
      if (step.navigate_url) {
        const url = playbook.base_url.replace(/\/$/, '') + step.navigate_url;
        await page.goto(url, { waitUntil: 'networkidle' });
      }

      if (step.delay_ms) {
        await page.waitForTimeout(step.delay_ms);
      }

      for (const field of step.fields) {
        const value = resolveValue(field.source, confirmedFields);
        if (!value) {
          if (!field.optional) {
            console.warn(`[Playbook] ${portalId}/${step.step_id}: missing required field "${field.name}"`);
          }
          continue;
        }

        const mapped = field.valueMap?.[value] ?? value;

        // For optional fields, do a quick existence check before attempting a fill.
        // This avoids the default 30-second Playwright timeout when a field only
        // appears conditionally (e.g. EV-only IDV box on a petrol vehicle).
        // Use 5s timeout — long enough for Angular re-renders but fast enough to fail
        // quickly for elements that truly don't exist (like the EV IDV on petrol vehicles).
        if (field.optional) {
          const exists = await page.locator(field.selector).first().isVisible({ timeout: 5_000 }).catch(() => false);
          if (!exists) {
            console.info(`[Playbook] ${portalId}/${step.step_id}/${field.name}: optional field not visible — skipping`);
            continue;
          }
        }

        try {
          switch (field.type) {
            case 'text':
            case 'date': {
              // Some Angular portals (e.g. UIIC) mark inputs readonly="readonly"
              // until the element receives focus. Strip the attribute first, fill,
              // then fire input+change so Angular's ng-model updates.
              await page.evaluate(
                (sel: string) => {
                  const el = document.querySelector(sel) as HTMLInputElement | null;
                  if (el) el.removeAttribute('readonly');
                },
                field.selector,
              ).catch(() => {});
              await page.click(field.selector, { timeout: 5_000 }).catch(() => {});
              await page.fill(field.selector, mapped);
              await page.evaluate(
                (sel: string) => {
                  const el = document.querySelector(sel) as HTMLInputElement | null;
                  if (!el) return;
                  el.dispatchEvent(new Event('input',  { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                },
                field.selector,
              ).catch(() => {});
              // Dismiss any calendar/datepicker popup that Angular may have opened
              await page.keyboard.press('Escape').catch(() => {});
              await page.waitForTimeout(150);
              break;
            }

            case 'select':
              // Try label first, fall back to value; fire change for Angular ng-model
              await page.selectOption(field.selector, { label: mapped }).catch(() =>
                page!.selectOption(field.selector, { value: mapped })
              );
              await page.evaluate(
                (sel: string) => document.querySelector(sel)?.dispatchEvent(new Event('change', { bubbles: true })),
                field.selector,
              ).catch(() => {});
              break;

            case 'radio':
              await page.check(`${field.selector}[value="${mapped}"]`);
              break;

            case 'checkbox':
              if (['true', 'yes', '1'].includes(mapped.toLowerCase())) {
                await page.check(field.selector);
              } else {
                await page.uncheck(field.selector);
              }
              await page.evaluate(
                (sel: string) => document.querySelector(sel)?.dispatchEvent(new Event('change', { bubbles: true })),
                field.selector,
              ).catch(() => {});
              break;
          }
          filled++;
        } catch (err: any) {
          console.warn(`[Playbook] ${portalId}/${step.step_id}/${field.name}: ${err.message}`);
        }
      }

      if (debugMode && step.next_trigger) {
        // Capture state immediately before clicking next (useful for CPA waiver dialogs)
        const preBuf = await page.screenshot({ fullPage: false }).catch(() => Buffer.from(''));
        const preHtml = await page.evaluate(() => {
          const lines: string[] = [];
          document.querySelectorAll('select').forEach(s => {
            const opts = Array.from((s as HTMLSelectElement).options).map(o => `${o.value}="${o.text.trim()}"`).join('; ');
            lines.push(`SELECT [id=${s.id}] selected=${(s as HTMLSelectElement).value} | ${opts}`);
          });
          document.querySelectorAll('input').forEach(i => {
            const el = i as HTMLInputElement;
            if (el.type === 'hidden') return;
            lines.push(`INPUT [id=${el.id} name=${el.name} type=${el.type}] value="${el.value}"`);
          });
          return lines.join('\n');
        }).catch(() => '');
        console.log(`[Debug] Step "${step.step_id}" PRE-CLICK:\n${preHtml || '(empty)'}`);
        debugSteps.push({ stepId: `${step.step_id}:pre_click`, screenshotBase64: preBuf.toString('base64'), formHtml: preHtml });
      }

      if (step.next_trigger) {
        if (step.next_trigger.action === 'click') {
          await page.click(step.next_trigger.selector);
        } else {
          await page.locator(step.next_trigger.selector).evaluate(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            el => (el as any).submit?.()
          );
        }
      }

      if (step.wait_after) {
        // In debug mode: if wait_after times out, still capture the page state before throwing
        if (debugMode) {
          try {
            await page.waitForSelector(step.wait_after, { timeout: 30_000 });
          } catch (waitErr: any) {
            const buf = await page.screenshot({ fullPage: false }).catch(() => Buffer.from(''));
            const html = await page.evaluate(() => {
              const lines: string[] = [];
              document.querySelectorAll('select').forEach(s => {
                const opts = Array.from((s as HTMLSelectElement).options).map(o => `${o.value}="${o.text.trim()}"`).join('; ');
                lines.push(`SELECT [id=${s.id}] selected=${(s as HTMLSelectElement).value} | ${opts}`);
              });
              document.querySelectorAll('input').forEach(i => {
                const el = i as HTMLInputElement;
                if (el.type === 'hidden') return;
                lines.push(`INPUT [id=${el.id} name=${el.name} type=${el.type}] value="${el.value}"`);
              });
              return lines.join('\n');
            }).catch(() => '');
            console.log(`[Debug] Step "${step.step_id}" TIMEOUT STATE:\n${html || '(empty)'}`);
            debugSteps.push({ stepId: `${step.step_id}:timeout`, screenshotBase64: buf.toString('base64'), formHtml: html });
            throw waitErr;
          }
        } else {
          await page.waitForSelector(step.wait_after, { timeout: 30_000 });
        }
      } else {
        await page.waitForLoadState('networkidle');
      }

      if (debugMode) {
        const buf = await page.screenshot({ fullPage: false }).catch(() => Buffer.from(''));
        const formHtml = await page.evaluate(() => {
          const lines: string[] = [];
          // All selects on the page
          document.querySelectorAll('select').forEach(s => {
            const opts = Array.from((s as HTMLSelectElement).options)
              .map(o => `${o.value}="${o.text.trim()}"`)
              .join('; ');
            lines.push(`SELECT [id=${s.id} name=${s.name} class=${s.className}] selected=${(s as HTMLSelectElement).value} | ${opts}`);
          });
          // All visible inputs
          document.querySelectorAll('input').forEach(i => {
            const el = i as HTMLInputElement;
            if (el.type === 'hidden') return;
            lines.push(`INPUT [id=${el.id} name=${el.name} type=${el.type}] value="${el.value}" readonly=${el.readOnly}`);
          });
          return lines.join('\n');
        }).catch(e => `evaluate error: ${e}`);
        console.log(`[Debug] Step "${step.step_id}" form state:\n${formHtml || '(empty)'}`);
        debugSteps.push({ stepId: step.step_id, screenshotBase64: buf.toString('base64'), formHtml });
      }

      logEvent({
        userId, userEmail, sessionId, portalId,
        action: 'form_step_filled', outcome: 'success',
        durationMs: Date.now() - stepStart,
        meta: { stepId: step.step_id, fieldsCount: filled },
      });
    }

    // ── Extract result ─────────────────────────────────────────────────────
    const qr = playbook.quote_result;

    if (qr.result_page_indicator) {
      await page.waitForSelector(qr.result_page_indicator, { timeout: 45_000 });
    }

    // In debug mode: dump all table text so we can tune selectors
    if (debugMode) {
      const tableHtml = await page.evaluate(() => {
        const out: string[] = [];
        document.querySelectorAll('table').forEach((t, i) => {
          out.push(`TABLE ${i}: ${t.className || t.id}`);
          t.querySelectorAll('tr').forEach(r => {
            const cells = Array.from(r.cells).map(c => c.textContent?.trim() ?? '');
            out.push('  ROW: ' + cells.join(' | '));
          });
        });
        return out.join('\n');
      }).catch(() => '');
      console.log('[Debug] Result page tables:\n' + tableHtml);
    }

    const rawData: Record<string, string> = {};
    let premium: number | null = null;
    let idv:     number | null = null;

    // Helper to read a selector and extract a numeric value
    async function extractAmount(selector?: string, label?: string): Promise<number | null> {
      if (!selector) return null;
      const text = await page!.locator(selector).first().textContent().catch(() => null);
      if (!text) return null;
      if (label) rawData[`${label}_text`] = text.trim();
      const num = parseFloat(text.replace(/[^\d.]/g, ''));
      return isNaN(num) ? null : num;
    }

    async function extractString(selector?: string, label?: string): Promise<string | null> {
      if (!selector) return null;
      const text = await page!.locator(selector).first().textContent().catch(() => null);
      if (!text) return null;
      const val = text.trim();
      if (label) rawData[label] = val;
      return val;
    }

    premium                  = await extractAmount(qr.premium_selector,            'premium');
    idv                      = await extractAmount(qr.idv_selector,                'idv');
    const odPremium          = await extractAmount(qr.od_premium_selector,         'od_premium');
    const tpPremium          = await extractAmount(qr.tp_premium_selector,         'tp_premium');
    const gstAmount          = await extractAmount(qr.gst_selector,                'gst');
    const ncbAmount          = await extractAmount(qr.ncb_amount_selector,         'ncb_amount');
    const addonZeroDep       = await extractAmount(qr.addon_zero_dep_selector,     'addon_zero_dep');
    const addonEngine        = await extractAmount(qr.addon_engine_protect_selector, 'addon_engine_protect');
    const addonRsa           = await extractAmount(qr.addon_rsa_selector,          'addon_rsa');
    const addonPa            = await extractAmount(qr.addon_pa_selector,           'addon_pa');
    const cashlessCount      = await extractAmount(qr.cashless_count_selector,     'cashless_count');
    const quoteRef           = await extractString(qr.quote_ref_selector,          'quote_ref');

    let screenshotBase64: string | null = null;
    if (qr.full_page_screenshot) {
      const buf = await page.screenshot({ fullPage: true });
      screenshotBase64 = buf.toString('base64');
    }

    const durationMs = Date.now() - start;

    logEvent({
      userId, userEmail, sessionId, portalId,
      action: 'quote_generated', outcome: 'success',
      durationMs,
      meta: { premiumBand: premium ? `${Math.round(premium / 1000)}k` : 'unknown' },
    });
    const premiumStr = premium != null
      ? `₹${premium.toLocaleString('en-IN')}`
      : 'calculated';
    onProgress?.({
      type: 'result', portalId, portalName: playbook.name,
      message: `✅ ${playbook.name}: Premium ${premiumStr}`,
      ts: Date.now(),
      data: { premium, idv },
    });

    // If buy_flow is supported AND the caller asked for resume state,
    // snapshot the session BEFORE we close the page. This lets us re-create
    // an equivalent context later from cookies + localStorage + URL.
    let resumeState: { storageState: unknown; resumeUrl: string } | undefined;
    if (extractResumeState && playbook.buy_flow && page) {
      try {
        const storageState = await context.storageState();
        const resumeUrl    = page.url();
        resumeState = { storageState, resumeUrl };
      } catch (err: any) {
        console.warn('[Playbook] Could not extract resume state:', err.message);
      }
    }

    return {
      portalId, portalName: playbook.name,
      success: true, premium, idv, screenshotBase64, rawData,
      errorMessage: null, durationMs,
      odPremium, tpPremium, gstAmount, ncbAmount,
      addonZeroDep, addonEngine, addonRsa, addonPa,
      cashlessCount, quoteRef,
      supportsProceed: !!playbook.buy_flow,
      ...(debugMode  && { debugSteps }),
      ...(resumeState && { resumeState }),
    };

  } catch (err: any) {
    const durationMs = Date.now() - start;

    // CaptchaRequiredError is not a failure — it's a human-input request. Re-throw it.
    if (err instanceof CaptchaRequiredError) throw err;

    logEvent({
      userId, userEmail, sessionId, portalId,
      action: 'quote_failed', outcome: 'failure',
      durationMs,
      meta: { error: err.message },
    });
    onProgress?.({
      type: 'error', portalId, portalName: portalId,
      message: `❌ ${portalId}: ${err.message}`,
      ts: Date.now(),
    });

    let screenshotBase64: string | null = null;
    if (page) {
      try {
        const buf = await page.screenshot({ fullPage: false });
        screenshotBase64 = buf.toString('base64');
      } catch { /* ignore */ }
    }

    return {
      portalId, portalName: portalId,
      success: false, premium: null, idv: null,
      screenshotBase64, rawData: {},
      errorMessage: err.message, durationMs,
      ...(debugMode && { debugSteps }),
    };

  } finally {
    // We always close the page now — resume state lives in DB (cookies +
    // localStorage + URL), not in a hot Page reference. Keeping pages alive
    // was process-local and broke on every restart.
    if (page) {
      try { await page.close(); } catch { /* ignore */ }
    }
  }
}

// ── Buy flow runner ─────────────────────────────────────────────────────────

export interface BuyFlowResult {
  paymentUrl:          string | null;
  confirmationNumber:  string | null;
  policyPdfUrl:        string | null;
  errorMessage:        string | null;
  screenshotBase64:    string | null;
}

/**
 * Run the playbook's buy_flow steps. Reconstructs the browser session from
 * persisted storage state + resume URL — works even if the original quote
 * happened on a different process or before a restart.
 *
 * Caller provides a fresh BrowserContext and must release the pool slot
 * after this returns. The page created here is closed before return.
 */
export async function runBuyFlow(
  portalId:     string,
  context:      BrowserContext,
  resumeUrl:    string,
  onProgress?:  (event: ProgressEvent) => void,
): Promise<BuyFlowResult> {
  const playbook = loadPlaybook(portalId);

  if (!playbook.buy_flow) {
    return {
      paymentUrl: null, confirmationNumber: null, policyPdfUrl: null,
      errorMessage: `Portal "${portalId}" doesn't support the buy flow yet.`,
      screenshotBase64: null,
    };
  }

  const { steps, payment_url_extractor, confirmation_number_selector, policy_pdf_link_selector } =
    playbook.buy_flow;

  let page: Page | null = null;
  try {
    onProgress?.({
      type: 'step', portalId, portalName: playbook.name,
      message: `→ Resuming session…`,
      ts: Date.now(),
    });

    // Resume the quote: open new tab, navigate to the URL the quote landed on.
    // Cookies + localStorage were restored when the BrowserContext was created.
    page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(resumeUrl, { waitUntil: 'networkidle' });

    onProgress?.({
      type: 'step', portalId, portalName: playbook.name,
      message: `→ Generating payment link…`,
      ts: Date.now(),
    });

    // Execute each buy_flow step (mirror of quote_flow execution)
    for (const step of steps) {
      if (step.delay_ms) await page.waitForTimeout(step.delay_ms);

      if (step.next_trigger) {
        if (step.next_trigger.action === 'click') {
          await page.click(step.next_trigger.selector);
        } else {
          await page.locator(step.next_trigger.selector).evaluate(el => (el as any).submit?.());
        }
      }

      if (step.wait_after) {
        await page.waitForSelector(step.wait_after, { timeout: 30_000 });
      } else {
        await page.waitForLoadState('networkidle');
      }
    }

    // Extract payment URL
    let paymentUrl: string | null = null;
    switch (payment_url_extractor.strategy) {
      case 'current_url':
        paymentUrl = page.url();
        break;
      case 'href':
        if (payment_url_extractor.selector) {
          paymentUrl = await page.locator(payment_url_extractor.selector).first().getAttribute('href');
        }
        break;
      case 'text':
        if (payment_url_extractor.selector) {
          paymentUrl = await page.locator(payment_url_extractor.selector).first().textContent();
          paymentUrl = paymentUrl?.trim() ?? null;
        }
        break;
    }

    // Apply optional regex
    if (paymentUrl && payment_url_extractor.url_regex) {
      const m = paymentUrl.match(new RegExp(payment_url_extractor.url_regex));
      paymentUrl = m?.[1] ?? m?.[0] ?? paymentUrl;
    }

    let confirmationNumber: string | null = null;
    if (confirmation_number_selector) {
      confirmationNumber = await page.locator(confirmation_number_selector).first().textContent().catch(() => null);
      confirmationNumber = confirmationNumber?.trim() ?? null;
    }

    let policyPdfUrl: string | null = null;
    if (policy_pdf_link_selector) {
      policyPdfUrl = await page.locator(policy_pdf_link_selector).first().getAttribute('href').catch(() => null);
    }

    const screenshot = await page.screenshot({ fullPage: false }).catch(() => null);

    onProgress?.({
      type: 'result', portalId, portalName: playbook.name,
      message: paymentUrl ? `✅ Payment link ready` : `⚠️ Couldn't capture payment link`,
      ts: Date.now(),
    });

    return {
      paymentUrl,
      confirmationNumber,
      policyPdfUrl,
      errorMessage: null,
      screenshotBase64: screenshot?.toString('base64') ?? null,
    };
  } catch (err: any) {
    const screenshot = page
      ? await page.screenshot({ fullPage: false }).catch(() => null)
      : null;
    return {
      paymentUrl: null,
      confirmationNumber: null,
      policyPdfUrl: null,
      errorMessage: err.message,
      screenshotBase64: screenshot?.toString('base64') ?? null,
    };
  } finally {
    if (page) { try { await page.close(); } catch { /* ignore */ } }
  }
}
