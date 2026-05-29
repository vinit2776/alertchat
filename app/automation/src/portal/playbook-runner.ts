import { BrowserContext, Page } from 'playwright';
import * as fs   from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { logEvent } from '../audit/logger';
import { getCredentials } from '../credentials/vault';
import { config } from '../config/env';
import type { ProgressEvent } from '../session/progress';

let _anthropic: Anthropic | null = null;
function getAI(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
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
  const el = page.locator(imgSelector).first();
  const buf = await el.screenshot();

  const response = await getAI().messages.create({
    model:      'claude-haiku-4-5-20251001',
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

  // Strip whitespace — AI sometimes adds spaces between characters
  const text = (response.content.find(b => b.type === 'text')?.text ?? '')
    .trim()
    .replace(/\s+/g, '');
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
): Promise<QuoteRunResult & { debugSteps?: Array<{ stepId: string; screenshotBase64: string; formHtml?: string }> }> {
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
    await page.goto(loginUrl, { waitUntil: 'networkidle' });

    // Dismiss any announcement modals / PWA prompts that block the form
    if (playbook.login.dismiss_modals?.length) {
      for (const sel of playbook.login.dismiss_modals) {
        await page.locator(sel).first().click({ timeout: 5_000 }).catch(() => {
          // Modal may not have appeared — that's fine, continue
        });
        await page.waitForTimeout(300);
      }
    }

    const creds = await getCredentials(portalId);

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

    if (qr.premium_selector) {
      const text = await page.locator(qr.premium_selector).first().textContent().catch(() => null);
      if (text) {
        rawData.premium_text = text.trim();
        const num = parseFloat(text.replace(/[^\d.]/g, ''));
        if (!isNaN(num)) premium = num;
      }
    }

    if (qr.idv_selector) {
      const text = await page.locator(qr.idv_selector).first().textContent().catch(() => null);
      if (text) {
        rawData.idv_text = text.trim();
        const num = parseFloat(text.replace(/[^\d.]/g, ''));
        if (!isNaN(num)) idv = num;
      }
    }

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

    return {
      portalId, portalName: playbook.name,
      success: true, premium, idv, screenshotBase64, rawData,
      errorMessage: null, durationMs,
      ...(debugMode && { debugSteps }),
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
    if (page) {
      try { await page.close(); } catch { /* ignore */ }
    }
  }
}
