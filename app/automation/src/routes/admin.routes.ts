import { Router, Request, Response, NextFunction } from 'express';
import { Page } from 'playwright';
import { requireAdmin } from '../middleware/auth';
import { query, queryOne } from '../db/client';
import {
  getAllCompanies, getCompanyById, setEnabled, upsertCompany, updateLastTested,
} from '../portal/registry';
import { getSessionStats } from '../ai/conversation';
import { logEvent } from '../audit/logger';
import { InsuranceType } from '../types';
import { browserPool } from '../session/pool';
import { loadPlaybook } from '../portal/playbook-runner';
import { getCredentials } from '../credentials/vault';
import {
  saveProfile, loadProfile, getProfileDir, getScreenshotPath,
  hashFieldIds, PortalProfile, StepSnapshot,
} from '../portal/profile-manager';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/env';
import * as fs from 'fs';
import * as path from 'path';
import { getConnectorType } from '../connectors/registry';
import { getCacheStatus, refreshVehicleCache } from '../connectors/bajaj/vehicle-master';

let _ai: Anthropic | null = null;
function getAI() {
  if (!_ai) _ai = new Anthropic(config.anthropicApiKey ? { apiKey: config.anthropicApiKey } : {});
  return _ai;
}

const router = Router();

// ── Shared portal login helper ─────────────────────────────────────────────
// NEVER auto-retries — lockout risk is too high.
// If AI captcha solve fails: returns captchaRequired=true + fresh captcha image.
// Caller must display the image to a human and re-call with captchaOverride.

interface LoginOk      { captchaRequired: false; captchaSolved: string | null }
interface LoginNeedCap { captchaRequired: true;  captchaImageBase64: string }
type LoginOutcome = LoginOk | LoginNeedCap;

async function loginToPortal(
  page: Page,
  playbook: ReturnType<typeof loadPlaybook>,
  creds: { username: string; password: string },
  captchaOverride?: string,
): Promise<LoginOutcome> {
  const loginUrl = playbook.base_url.replace(/\/$/, '') + playbook.login.url;
  await page.goto(loginUrl, { waitUntil: 'networkidle' });

  if (playbook.login.dismiss_modals?.length) {
    for (const sel of playbook.login.dismiss_modals) {
      await page.locator(sel).first().click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
  }

  await page.click(playbook.login.username_field);
  await page.fill(playbook.login.username_field, creds.username);
  await page.click(playbook.login.password_field);
  await page.fill(playbook.login.password_field, creds.password);

  let captchaSolved: string | null = null;

  if (playbook.login.captcha) {
    const { image_selector, input_selector } = playbook.login.captcha;
    await page.waitForSelector(image_selector, { timeout: 10_000 });

    if (captchaOverride) {
      // Human provided — use it directly, no AI call
      captchaSolved = captchaOverride;
    } else {
      // Try AI once (no retries)
      const capBuf = await page.locator(image_selector).first().screenshot();
      const aiResp = await getAI().messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 32,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: capBuf.toString('base64') } },
          { type: 'text', text: 'This is a CAPTCHA image from an insurance portal. Return ONLY the characters shown, nothing else.' },
        ]}],
      });
      captchaSolved = aiResp.content.find(b => b.type === 'text')?.text?.trim() ?? '';
    }

    await page.fill(input_selector, captchaSolved);
  }

  await page.click(playbook.login.submit);

  const loginOk = await page.waitForSelector(playbook.login.success_indicator, { timeout: 20_000 })
    .then(() => true).catch(() => false);

  if (!loginOk) {
    if (playbook.login.captcha) {
      // Check if the captcha element still exists on the page.
      // If it doesn't, we're probably on the home page (login worked but wrong success_indicator).
      // In that case, throw a descriptive error rather than returning captchaRequired.
      const captchaStillPresent = await page.locator(playbook.login.captcha.image_selector)
        .isVisible({ timeout: 2_000 }).catch(() => false);

      if (!captchaStillPresent) {
        // We moved past login — wrong success_indicator in playbook
        throw new Error(`Login appears successful (captcha gone) but success_indicator "${playbook.login.success_indicator}" not found on post-login page. Update the playbook selector.`);
      }

      // Captcha is still on screen — login genuinely failed. Screenshot fresh captcha for human.
      await page.waitForTimeout(500);
      const freshBuf = await page.locator(playbook.login.captcha.image_selector).first().screenshot()
        .catch(async () => page.screenshot({ fullPage: false }));
      return { captchaRequired: true, captchaImageBase64: freshBuf.toString('base64') };
    }
    throw new Error('Login failed — success indicator not found and no captcha to show');
  }

  return { captchaRequired: false, captchaSolved };
}

// ── Company registry ───────────────────────────────────────────────────────

// GET /api/admin/companies
// Returns all companies enriched with connector type and credential/cache status.
router.get('/companies', requireAdmin, async (_req, res, next) => {
  try {
    const companies = await getAllCompanies();

    const enriched = companies.map(c => {
      const connectorType = getConnectorType(c.id);

      // Credential status — for API connectors, check env vars (never expose values)
      let credentialsConfigured = false;
      let credentialNote: string | null = null;
      if (connectorType === 'api') {
        if (c.id === 'bajaj') {
          credentialsConfigured = !!(config.bajaj.userId && config.bajaj.password);
          credentialNote = credentialsConfigured
            ? (config.bajaj.useProd ? 'Production' : 'UAT / Testing')
            : 'Set BAJAJ_USER_ID and BAJAJ_PASSWORD in .env to activate';
        }
      } else {
        // Portal: credential in vault — just check it exists
        credentialsConfigured = true; // vault handles this; test login will surface errors
      }

      // Cache status for Bajaj
      let cacheStatus: object | null = null;
      if (c.id === 'bajaj') {
        cacheStatus = getCacheStatus();
      }

      return {
        ...c,
        connectorType,
        credentialsConfigured,
        credentialNote,
        cacheStatus,
      };
    });

    res.json({ success: true, companies: enriched });
  } catch (err) { next(err); }
});

// PATCH /api/admin/companies/:id/enabled
router.patch('/companies/:id/enabled', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { enabled } = req.body as { enabled: boolean };
    const company = await setEnabled(req.params.id, enabled);
    if (!company) { res.status(404).json({ success: false, message: 'Company not found' }); return; }

    logEvent({
      userId: req.user!.sub, userEmail: req.user!.email, sessionId: 'admin',
      action: 'admin_action', outcome: 'success',
      meta: { action: 'set_enabled', companyId: req.params.id, enabled },
    });

    res.json({ success: true, company });
  } catch (err) { next(err); }
});

// PUT /api/admin/companies/:id  — create or update
router.put('/companies/:id', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, logoUrl, insuranceTypes, playbookVersion, enabled, credentialSecretKey } = req.body;
    const company = await upsertCompany({
      id: req.params.id, name, logoUrl, insuranceTypes, playbookVersion, enabled, credentialSecretKey,
    });
    logEvent({
      userId: req.user!.sub, userEmail: req.user!.email, sessionId: 'admin',
      action: 'admin_action', outcome: 'success',
      meta: { action: 'upsert_company', companyId: req.params.id },
    });
    res.json({ success: true, company });
  } catch (err) { next(err); }
});

// ── Bajaj API management ───────────────────────────────────────────────────

// GET /api/admin/bajaj/cache-status
router.get('/bajaj/cache-status', requireAdmin, (_req, res) => {
  res.json({ success: true, ...getCacheStatus() });
});

// POST /api/admin/bajaj/refresh-vehicles
// Fetches all vehicle make/model/subtype data from Bajaj API and caches locally.
// Background operation — streams progress via JSON lines response.
router.post('/bajaj/refresh-vehicles', requireAdmin, async (req: Request, res: Response) => {
  if (!config.bajaj.userId || !config.bajaj.password) {
    res.status(400).json({
      success: false,
      message: 'Bajaj credentials not configured. Set BAJAJ_USER_ID and BAJAJ_PASSWORD in .env first.',
    });
    return;
  }

  const messages: string[] = [];
  try {
    const result = await refreshVehicleCache(
      ['1801', '1802'],
      (msg) => { messages.push(msg); },
    );

    logEvent({
      userId: req.user!.sub, userEmail: req.user!.email, sessionId: 'admin',
      action: 'admin_action', outcome: result.errors.length === 0 ? 'success' : 'failure',
      meta: { action: 'bajaj_cache_refresh', added: result.added, errors: result.errors.length },
    });

    res.json({
      success:  result.errors.length === 0,
      added:    result.added,
      errors:   result.errors,
      messages,
      cacheStatus: getCacheStatus(),
    });
  } catch (err: any) {
    res.status(502).json({ success: false, message: err.message, messages });
  }
});

// POST /api/admin/bajaj/test-api
// Makes a minimal API call to verify credentials are working.
router.post('/bajaj/test-api', requireAdmin, async (req: Request, res: Response) => {
  if (!config.bajaj.userId || !config.bajaj.password) {
    res.status(400).json({ success: false, message: 'Bajaj credentials not configured.' });
    return;
  }
  try {
    const { getAllVehicleMakes } = await import('../connectors/bajaj/client');
    const makes = await getAllVehicleMakes('1801');
    res.json({
      success: true,
      message: `API connected — ${makes.length} vehicle makes returned`,
      sampleMakes: makes.slice(0, 5).map((m: any) => m.vehiclemake),
    });
  } catch (err: any) {
    res.status(502).json({ success: false, message: err.message });
  }
});

// ── Portal company tests ───────────────────────────────────────────────────

// POST /api/admin/companies/:id/test
// Logs into the portal with real Playwright, returns a screenshot and nav links.
// Body: { captchaText?: string }  — supply human-read captcha if AI failed last time.
// If AI captcha solve fails: returns { captchaRequired: true, captchaImageBase64 }
// — show that image to a human, then re-call with captchaText. NO auto-retries.
router.post('/companies/:id/test', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  const sessionKey = `admin-test:${req.params.id}:${Date.now()}`;
  let acquired = false;

  try {
    const { captchaText: captchaOverride } = req.body as { captchaText?: string };

    const company = await getCompanyById(req.params.id);
    if (!company) { res.status(404).json({ success: false, message: 'Company not found' }); return; }

    let playbook: ReturnType<typeof loadPlaybook>;
    try {
      playbook = loadPlaybook(req.params.id);
    } catch {
      res.status(404).json({ success: false, message: `No playbook found for ${req.params.id}.` });
      return;
    }

    const creds = await getCredentials(req.params.id);
    const { slotId, context } = await browserPool.acquire(sessionKey);
    acquired = true;

    const page = await context.newPage();
    page.setDefaultTimeout(30_000);

    try {
      const outcome = await loginToPortal(page, playbook, creds, captchaOverride);

      if (outcome.captchaRequired) {
        // Human must read the captcha and re-call this endpoint with captchaText
        res.json({
          success:             false,
          captchaRequired:     true,
          captchaImageBase64:  outcome.captchaImageBase64,
          message:             'AI captcha solve failed. Read the image and re-call with { captchaText: "..." }',
        });
        return;
      }

      // ── Post-login: extract nav and policy submenu ─────────────────────────
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const navLinks: any[] = await page.evaluate(() =>
        // @ts-ignore
        Array.from(document.querySelectorAll('a'))
          // @ts-ignore
          .map((a: any) => ({
            text:    (a.textContent ?? '').replace(/\s+/g, ' ').trim(),
            href:    a.getAttribute('href') ?? '',
            onclick: a.getAttribute('onclick') ?? '',
          }))
          // @ts-ignore
          .filter((l: any) => l.text.length > 1 && l.text.length < 80)
      );

      const screenshotBuf = await page.screenshot({ fullPage: false });

      let policyMenuScreenshot: string | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let policySubLinks: any[] = [];
      try {
        await page.locator('a:has-text("Policy Transaction"), a:has-text("Policy Transact")').first().click({ timeout: 5_000 });
        await page.waitForTimeout(1500);
        policyMenuScreenshot = (await page.screenshot({ fullPage: false })).toString('base64');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        policySubLinks = await page.evaluate(() =>
          // @ts-ignore
          Array.from(document.querySelectorAll('.collapse.in a, [aria-expanded=true] ~ ul a, ul.nav-second-level a, li.active > ul a'))
            // @ts-ignore
            .map((a: any) => ({ text: (a.textContent ?? '').replace(/\s+/g, ' ').trim(), href: a.getAttribute('href') ?? '' }))
            // @ts-ignore
            .filter((l: any) => l.text.length > 1)
        );
      } catch { /* menu may not be present */ }

      await updateLastTested(req.params.id, true);
      logEvent({
        userId: req.user!.sub, userEmail: req.user!.email, sessionId: 'admin',
        portalId: req.params.id, action: 'portal_login', outcome: 'success',
        meta: { test: true, slotId, captchaSolved: outcome.captchaSolved !== null },
      });

      res.json({
        success:           true,
        loginStatus:       'ok',
        pageTitle:         await page.title(),
        currentUrl:        page.url(),
        captchaSolved:     outcome.captchaSolved,
        screenshotBase64:  screenshotBuf.toString('base64'),
        policyMenuScreenshot,
        navLinks:          navLinks.slice(0, 80),
        policySubLinks,
      });

    } finally {
      await page.close();
    }

  } catch (err: any) {
    await updateLastTested(req.params.id, false).catch(() => {});
    res.status(502).json({ success: false, message: err.message });
  } finally {
    if (acquired) await browserPool.release(sessionKey);
  }
});

// POST /api/admin/companies/:id/explore
// Login, navigate to a URL, optionally click an element, return screenshot + form fields.
// Body: { navigateTo?, clickText?, clickSelector?, captchaText? }
// If AI captcha solve fails: returns { captchaRequired: true, captchaImageBase64 }.
// Re-call with captchaText set to the human-read value. NO auto-retries.
router.post('/companies/:id/explore', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  const sessionKey = `admin-explore:${req.params.id}:${Date.now()}`;
  let acquired = false;

  try {
    const { navigateTo, clickText, clickSelector, captchaText: captchaOverride } = req.body as {
      navigateTo?:    string;
      clickText?:     string;
      clickSelector?: string;
      captchaText?:   string;
    };

    let playbook: ReturnType<typeof loadPlaybook>;
    try { playbook = loadPlaybook(req.params.id); }
    catch { res.status(404).json({ success: false, message: `No playbook for ${req.params.id}` }); return; }

    const creds = await getCredentials(req.params.id);
    const { context } = await browserPool.acquire(sessionKey);
    acquired = true;

    const page = await context.newPage();
    page.setDefaultTimeout(30_000);

    const outcome = await loginToPortal(page, playbook, creds, captchaOverride);

    if (outcome.captchaRequired) {
      await page.close();
      res.json({
        success:             false,
        captchaRequired:     true,
        captchaImageBase64:  outcome.captchaImageBase64,
        message:             'AI captcha solve failed. Read the image and re-call with { captchaText: "..." }',
      });
      return;
    }

    // Navigate to requested URL
    if (navigateTo) {
      await page.goto(navigateTo, { waitUntil: 'networkidle' });
    }

    // Click an element if requested
    if (clickText) {
      await page.locator(`text=${clickText}`).first().click({ timeout: 10_000 });
      await page.waitForLoadState('networkidle');
    } else if (clickSelector) {
      await page.locator(clickSelector).first().click({ timeout: 10_000 });
      await page.waitForLoadState('networkidle');
    }

    await page.waitForTimeout(800);

    // Capture full state
    const screenshot = (await page.screenshot({ fullPage: true })).toString('base64');
    const pageTitle  = await page.title();
    const currentUrl = page.url();

    // Extract all form fields
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const formFields: any[] = await page.evaluate((): any[] => {
      // @ts-ignore
      return Array.from(document.querySelectorAll('input, select, textarea')).map((el: any) => ({
        tag:         el.tagName,
        type:        el.type,
        id:          el.id,
        name:        el.name,
        placeholder: el.placeholder,
        // @ts-ignore — document is available in browser context
        label:       el.labels?.[0]?.innerText?.trim() || document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim() || '',
        options:     el.tagName === 'SELECT'
          ? Array.from(el.options).map((o: any) => ({ value: o.value, text: o.text })).slice(0, 20)
          : undefined,
      })).filter((f: any) => f.id || f.name);
    });

    // Extract all clickable buttons on the page
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buttons: any[] = await page.evaluate((): any[] =>
      // @ts-ignore
      Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], a.btn')).map((el: any) => ({
        tag:      el.tagName,
        type:     el.type,
        id:       el.id,
        text:     (el.textContent ?? el.value ?? '').replace(/\s+/g, ' ').trim(),
        selector: el.id ? `#${el.id}` : (el.name ? `[name="${el.name}"]` : el.className ? `.${(el.className as string).split(' ')[0]}` : el.tagName.toLowerCase()),
      })).filter((b: any) => b.text || b.id)
    );

    await page.close();

    res.json({
      success: true, pageTitle, currentUrl,
      screenshot, formFields, buttons,
    });

  } catch (err: any) {
    res.status(502).json({ success: false, message: err.message });
  } finally {
    if (acquired) await browserPool.release(sessionKey);
  }
});

// ── Portal profile / discovery ─────────────────────────────────────────────

// Snapshot helper: capture screenshot + all form fields + buttons + links from a page.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function snapshotPage(page: Page, stepId: string): Promise<Omit<StepSnapshot, 'nav_steps'>> {
  const [screenshotBuf, title, url, rawFields, rawButtons, rawLinks] = await Promise.all([
    page.screenshot({ fullPage: true }),
    page.title(),
    Promise.resolve(page.url()),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page.evaluate((): any[] =>
      // @ts-ignore
      Array.from(document.querySelectorAll('input, select, textarea'))
        // @ts-ignore
        .map((el: any) => ({
          tag:         el.tagName,
          type:        el.type ?? '',
          id:          el.id ?? '',
          name:        el.name ?? '',
          placeholder: el.placeholder ?? '',
          // @ts-ignore
          label: (el.labels?.[0]?.innerText?.trim()) || (document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim()) || '',
          options: el.tagName === 'SELECT'
            ? Array.from(el.options).map((o: any) => ({ value: o.value, text: o.text })).slice(0, 30)
            : undefined,
        }))
        // @ts-ignore
        .filter((f: any) => f.id || f.name)
    ),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page.evaluate((): any[] =>
      // @ts-ignore
      Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], a.btn'))
        // @ts-ignore
        .map((el: any) => ({
          id:       el.id ?? '',
          text:     (el.textContent ?? el.value ?? '').replace(/\s+/g, ' ').trim(),
          selector: el.id ? `#${el.id}` : (el.name ? `[name="${el.name}"]` : el.className ? `.${(el.className as string).split(' ')[0]}` : el.tagName.toLowerCase()),
        }))
        // @ts-ignore
        .filter((b: any) => b.text)
    ),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page.evaluate((): any[] =>
      // @ts-ignore
      Array.from(document.querySelectorAll('a'))
        // @ts-ignore
        .map((a: any) => ({ text: (a.textContent ?? '').replace(/\s+/g, ' ').trim(), href: a.getAttribute('href') ?? '' }))
        // @ts-ignore
        .filter((l: any) => l.text.length > 1 && l.text.length < 80)
        .slice(0, 60)
    ),
  ]);

  // Build the best CSS selector for each field
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const form_fields = (rawFields as any[]).map((f: any) => ({
    id:       f.id,
    name:     f.name,
    type:     f.type || f.tag.toLowerCase(),
    label:    f.label,
    selector: f.id ? `#${f.id}` : (f.name ? `[name="${f.name}"]` : ''),
    options:  f.options,
  }));

  const structure_hash = hashFieldIds(form_fields.map(f => f.id || f.name));

  return {
    step_id:          stepId,
    url,
    page_title:       title,
    structure_hash,
    form_fields,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buttons:          rawButtons as any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nav_links:        rawLinks as any[],
    screenshot_file:  `screenshot_${stepId}.png`,
    screenshot_base64: screenshotBuf.toString('base64'),
  };
}

// POST /api/admin/companies/:id/discover
// Performs a full guided navigation of the quote flow, snapshots every step,
// and saves a profile.json + screenshots to src/portal/profiles/:id/.
// Body:
//   captchaText?  — human-provided captcha if AI fails
//   navSteps?     — array of { label, action: 'click_text'|'click_selector'|'navigate', value }
//                   if omitted, uses the steps already saved in the profile (if any)
router.post('/companies/:id/discover', requireAdmin, async (req: Request, res: Response, _next: NextFunction) => {
  const sessionKey = `admin-discover:${req.params.id}:${Date.now()}`;
  let acquired = false;

  try {
    const {
      captchaText: captchaOverride,
      navSteps,
    } = req.body as {
      captchaText?: string;
      navSteps?: Array<{
        label:    string;
        action:   'click_text' | 'click_selector' | 'navigate' | 'select_option';
        value:    string;  // selector (for select_option/click_selector) or text/url
        option?:  string;  // option value to select (for select_option)
      }>;
    };

    let playbook: ReturnType<typeof loadPlaybook>;
    try { playbook = loadPlaybook(req.params.id); }
    catch { res.status(404).json({ success: false, message: `No playbook for ${req.params.id}` }); return; }

    // Use supplied navSteps, or fall back to existing profile's nav_steps
    const existingProfile = loadProfile(req.params.id);
    const steps = navSteps ?? existingProfile?.nav_steps;
    if (!steps?.length) {
      res.status(400).json({
        success: false,
        message: 'Provide navSteps in body (array of {label, action, value}). For UIIC Motor example: [{"label":"Policy Menu","action":"click_text","value":"Policy Transaction"},{"label":"New Policy","action":"click_text","value":"Make New/Renew Policy"},{"label":"Motor Calculator","action":"click_text","value":"Motor Premium Calculator"}]',
      });
      return;
    }

    const creds = await getCredentials(req.params.id);
    const { context } = await browserPool.acquire(sessionKey);
    acquired = true;
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);

    // ── Login ──────────────────────────────────────────────────────────────
    const outcome = await loginToPortal(page, playbook, creds, captchaOverride);
    if (outcome.captchaRequired) {
      await page.close();
      res.json({ success: false, captchaRequired: true, captchaImageBase64: outcome.captchaImageBase64,
        message: 'AI captcha solve failed. Re-call with { captchaText: "..." }' });
      return;
    }

    const snapshots: StepSnapshot[] = [];

    // ── Snapshot home (post-login) ─────────────────────────────────────────
    await page.waitForTimeout(600);
    snapshots.push(await snapshotPage(page, 'home'));

    // ── Execute nav steps, snapshot after each ────────────────────────────
    for (const step of steps) {
      try {
        if (step.action === 'navigate') {
          await page.goto(step.value, { waitUntil: 'networkidle' });
        } else if (step.action === 'click_text') {
          await page.locator(`text=${step.value}`).first().click({ timeout: 10_000 });
          await page.waitForLoadState('networkidle').catch(() => page.waitForTimeout(1500));
        } else if (step.action === 'click_selector') {
          await page.locator(step.value).first().click({ timeout: 10_000 });
          await page.waitForLoadState('networkidle').catch(() => page.waitForTimeout(1500));
        } else if (step.action === 'select_option') {
          // Try by value first, fall back to label
          await page.selectOption(step.value, { value: step.option ?? '' })
            .catch(() => page.selectOption(step.value, { label: step.option ?? '' }));
          await page.waitForTimeout(800); // wait for dependent selects to update
        }
        await page.waitForTimeout(600);
        snapshots.push(await snapshotPage(page, step.label.toLowerCase().replace(/[^a-z0-9]+/g, '_')));
      } catch (err: any) {
        console.warn(`[Discover] Step "${step.label}" failed: ${err.message}`);
        const errSnap = await snapshotPage(page, `${step.label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_error`);
        snapshots.push({ ...errSnap, page_title: `ERROR: ${err.message} | ${errSnap.page_title}` });
        break;
      }
    }

    await page.close();

    // ── Save profile ───────────────────────────────────────────────────────
    const profile: PortalProfile = {
      portal_id:      req.params.id,
      discovered_at:  new Date().toISOString(),
      login_verified: true,
      nav_steps:      steps,
      steps:          snapshots,
    };

    saveProfile(req.params.id, profile, new Map());

    logEvent({
      userId: req.user!.sub, userEmail: req.user!.email, sessionId: 'admin',
      portalId: req.params.id, action: 'admin_action', outcome: 'success',
      meta: { action: 'profile_discovered', steps_captured: snapshots.length },
    });

    // Return profile without large base64 payloads
    const summary = snapshots.map(s => ({
      step_id:        s.step_id,
      url:            s.url,
      page_title:     s.page_title,
      structure_hash: s.structure_hash,
      field_count:    s.form_fields.length,
      button_count:   s.buttons.length,
      form_fields:    s.form_fields,
      buttons:        s.buttons,
      screenshot_url: `/api/admin/companies/${req.params.id}/profile/screenshots/${s.step_id}`,
    }));

    res.json({
      success:       true,
      portal_id:     req.params.id,
      discovered_at: profile.discovered_at,
      steps:         summary,
    });

  } catch (err: any) {
    res.status(502).json({ success: false, message: err.message });
  } finally {
    if (acquired) await browserPool.release(sessionKey);
  }
});

// GET /api/admin/companies/:id/profile  — return stored profile (no screenshots)
router.get('/companies/:id/profile', requireAdmin, (req: Request, res: Response) => {
  const profile = loadProfile(req.params.id);
  if (!profile) {
    res.status(404).json({ success: false, message: `No profile found for ${req.params.id}. Run POST /discover first.` });
    return;
  }
  const summary = profile.steps.map(s => ({
    ...s,
    screenshot_url: `/api/admin/companies/${req.params.id}/profile/screenshots/${s.step_id}`,
  }));
  res.json({ success: true, profile: { ...profile, steps: summary } });
});

// GET /api/admin/companies/:id/profile/screenshots/:stepId  — serve PNG
router.get('/companies/:id/profile/screenshots/:stepId', requireAdmin, (req: Request, res: Response) => {
  const { id, stepId } = req.params;
  const profile = loadProfile(id);
  if (!profile) { res.status(404).send('No profile'); return; }

  const step = profile.steps.find(s => s.step_id === stepId);
  if (!step) { res.status(404).send('Step not found in profile'); return; }

  const pngPath = getScreenshotPath(id, step.screenshot_file);
  if (!fs.existsSync(pngPath)) { res.status(404).send('Screenshot file missing'); return; }

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'max-age=3600');
  res.sendFile(path.resolve(pngPath));
});

// ── Audit trail ────────────────────────────────────────────────────────────

// GET /api/admin/sessions  — filterable session list
router.get('/sessions', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, portalId, outcome, from, to, limit = '100', offset = '0' } = req.query as Record<string, string>;

    // Aggregate sessions from audit_events (one row per session_id)
    let sql = `
      SELECT
        session_id,
        user_id,
        MAX(user_email)              AS user_email,
        MIN(ts)                      AS started_at,
        MAX(ts)                      AS last_event_at,
        MAX(portal_id)               AS portal_id,
        MAX(ins_type)                AS ins_type,
        BOOL_OR(action = 'quote_generated')   AS quote_generated,
        BOOL_OR(action = 'session_end')       AS ended,
        BOOL_OR(outcome = 'failure')          AS had_error,
        COUNT(*)                     AS event_count
      FROM audit_events
      WHERE session_id != 'admin'
    `;
    const params: unknown[] = [];
    let i = 1;

    if (userId)  { sql += ` AND user_id  = $${i++}`; params.push(userId); }
    if (portalId){ sql += ` AND portal_id= $${i++}`; params.push(portalId); }
    if (from)    { sql += ` AND ts >= $${i++}`;       params.push(from); }
    if (to)      { sql += ` AND ts <= $${i++}`;       params.push(to); }

    sql += ` GROUP BY session_id, user_id ORDER BY started_at DESC LIMIT $${i++} OFFSET $${i++}`;
    params.push(parseInt(limit, 10), parseInt(offset, 10));

    const rows = await query<any>(sql, params);
    res.json({ success: true, sessions: rows });
  } catch (err) { next(err); }
});

// GET /api/admin/sessions/:id/timeline  — per-session event drill-down
router.get('/sessions/:id/timeline', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const events = await query<any>(
      `SELECT id, ts, user_id, user_email, portal_id, ins_type, action, outcome, duration_ms, meta
       FROM audit_events WHERE session_id = $1 ORDER BY ts ASC`,
      [req.params.id]
    );
    res.json({ success: true, timeline: events });
  } catch (err) { next(err); }
});

// ── Analytics ──────────────────────────────────────────────────────────────

// GET /api/admin/analytics
router.get('/analytics', requireAdmin, async (_req, res, next) => {
  try {
    const [overview, byPortal, byDay, failures] = await Promise.all([
      // Overview counts
      queryOne<any>(`
        SELECT
          COUNT(DISTINCT CASE WHEN action = 'session_start' THEN session_id END)            AS sessions_total,
          COUNT(DISTINCT CASE WHEN action = 'session_start' AND ts > now()-INTERVAL '1 day'   THEN session_id END) AS sessions_today,
          COUNT(DISTINCT CASE WHEN action = 'session_start' AND ts > now()-INTERVAL '7 days'  THEN session_id END) AS sessions_7d,
          COUNT(DISTINCT CASE WHEN action = 'quote_generated'                  THEN session_id END) AS quotes_generated,
          ROUND(AVG(duration_ms) FILTER (WHERE action = 'session_end'), 0)     AS avg_session_ms
        FROM audit_events WHERE session_id != 'admin'
      `),
      // Breakdown by portal
      query<any>(`
        SELECT portal_id,
               COUNT(DISTINCT CASE WHEN action = 'session_start'   THEN session_id END) AS sessions,
               COUNT(DISTINCT CASE WHEN action = 'quote_generated' THEN session_id END) AS quotes
        FROM audit_events WHERE portal_id IS NOT NULL GROUP BY portal_id ORDER BY sessions DESC
      `),
      // Sessions per day (last 30 days)
      query<any>(`
        SELECT DATE_TRUNC('day', ts) AS day,
               COUNT(DISTINCT session_id) AS sessions
        FROM audit_events
        WHERE action = 'session_start' AND ts > now()-INTERVAL '30 days'
        GROUP BY day ORDER BY day
      `),
      // Top failure reasons
      query<any>(`
        SELECT action, meta->>'error' AS reason, COUNT(*) AS cnt
        FROM audit_events WHERE outcome = 'failure' GROUP BY action, reason ORDER BY cnt DESC LIMIT 10
      `),
    ]);

    res.json({
      success: true,
      overview,
      byPortal,
      byDay,
      topFailures: failures,
      liveSessions: getSessionStats().activeSessions,
    });
  } catch (err) { next(err); }
});

// ── Admin quote records (full history, no TTL filter) ─────────────────────

// GET /api/admin/quotes
router.get('/quotes', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, portalId, regNumber, from, to, limit = '100', offset = '0' } = req.query as Record<string, string>;
    let sql = 'SELECT * FROM quote_results WHERE 1=1';
    const params: unknown[] = [];
    let i = 1;
    if (userId)    { sql += ` AND user_id   = $${i++}`; params.push(userId); }
    if (portalId)  { sql += ` AND portal_id = $${i++}`; params.push(portalId); }
    if (regNumber) { sql += ` AND reg_number ILIKE $${i++}`; params.push(`%${regNumber}%`); }
    if (from)      { sql += ` AND created_at >= $${i++}`; params.push(from); }
    if (to)        { sql += ` AND created_at <= $${i++}`; params.push(to); }
    sql += ` ORDER BY created_at DESC LIMIT $${i++} OFFSET $${i++}`;
    params.push(parseInt(limit, 10), parseInt(offset, 10));
    const rows = await query<any>(sql, params);
    res.json({ success: true, quotes: rows });
  } catch (err) { next(err); }
});

// ── Test quote captcha session store ─────────────────────────────────────────
// When a test-quote hits a captcha, we park the acquired browser slot here so
// the human can read the image and re-call with captchaText. TTL: 5 minutes.

interface ParkedCaptchaSession {
  sessionKey: string;
  enrichedFields: Record<string, string>;
  captchaImageBase64: string;
  expiresAt: number;
}
const parkedCaptchaSessions = new Map<string, ParkedCaptchaSession>();

function sweepExpiredCaptchaSessions() {
  const now = Date.now();
  for (const [k, v] of parkedCaptchaSessions) {
    if (v.expiresAt < now) {
      browserPool.release(v.sessionKey).catch(() => {});
      parkedCaptchaSessions.delete(k);
    }
  }
}

// ── Test quote (admin only) ───────────────────────────────────────────────────
// POST /api/admin/companies/:id/test-quote
//
// Phase 1 — no captchaToken in body:
//   Creates fresh browser context, runs playbook. If captcha is hit, parks the
//   session and returns { captchaRequired: true, captchaToken, captchaImageBase64 }.
//
// Phase 2 — captchaToken + captchaText in body:
//   Resumes the parked session (same browser context, same login page).
//   Fills in captchaText, completes login, runs the full quote flow.
//
// Body: { fields?: Record<string,string>, captchaToken?: string, captchaText?: string }
router.post('/companies/:id/test-quote', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const { fields = {}, captchaToken, captchaText, debug = false } = req.body as {
    fields?: Record<string,string>;
    captchaToken?: string;
    captchaText?: string;
    debug?: boolean;
  };
  const user = req.user!;

  sweepExpiredCaptchaSessions();

  const { runPlaybook, CaptchaRequiredError: CapErr } = await import('../portal/playbook-runner');
  const { computeMotorFields } = await import('../portal/field-computer');

  // ── Phase 2: resume parked session ──────────────────────────────────────────
  if (captchaToken && captchaText) {
    const parked = parkedCaptchaSessions.get(captchaToken);
    if (!parked) {
      res.status(400).json({ success: false, message: 'captchaToken not found or expired. Start a new test-quote.' });
      return;
    }
    parkedCaptchaSessions.delete(captchaToken);

    // Look up the existing context — no new acquire, slot is already held
    const context = browserPool.lookup(parked.sessionKey);
    if (!context) {
      res.status(400).json({ success: false, message: 'Parked browser session expired. Start a new test-quote.' });
      return;
    }

    try {
      const result = await runPlaybook(
        id, parked.enrichedFields, context,
        parked.sessionKey, user.sub, user.email,
        captchaText, debug,
      );

      res.json({ success: true, result, computedFields: parked.enrichedFields });
    } catch (err: any) {
      if (err?.name === 'CaptchaRequiredError') {
        const newToken = `cap_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        parkedCaptchaSessions.set(newToken, {
          sessionKey: parked.sessionKey,
          enrichedFields: parked.enrichedFields,
          captchaImageBase64: err.captchaImageBase64,
          expiresAt: Date.now() + 15 * 60_000,
        });
        res.status(422).json({
          success: false, captchaRequired: true,
          captchaToken: newToken,
          captchaImageBase64: err.captchaImageBase64,
          message: 'Captcha still required. Re-call with the new captchaToken + captchaText.',
        });
        return;
      }
      next(err);
    } finally {
      await browserPool.release(parked.sessionKey).catch(() => {});
    }
    return;
  }

  // ── Phase 1: fresh start ─────────────────────────────────────────────────────
  const enrichedFields = computeMotorFields(fields as Record<string, string>);

  // Pre-flight: check excluded conditions before acquiring a browser context.
  // This avoids burning a pool slot for vehicles the portal cannot quote.
  {
    const { loadPlaybook } = await import('../portal/playbook-runner');
    try {
      const playbook = loadPlaybook(id);
      if (playbook.excluded_conditions?.length) {
        for (const cond of playbook.excluded_conditions) {
          const fieldVal = (enrichedFields[cond.field] ?? '').toLowerCase();
          if (fieldVal === cond.value.toLowerCase()) {
            res.json({
              success: true,
              result: {
                portalId: id, portalName: playbook.name,
                success: false, premium: null, idv: null,
                screenshotBase64: null, rawData: {},
                errorMessage: cond.message, durationMs: 0,
              },
              computedFields: enrichedFields,
            });
            return;
          }
        }
      }
    } catch {
      // Playbook not found etc. — let the full runPlaybook path handle the error
    }
  }

  const sessionKey = `admin-test-${id}-${Date.now()}`;
  let acquired = false;

  try {
    const { context } = await browserPool.acquire(sessionKey);
    acquired = true;

    const result = await runPlaybook(
      id, enrichedFields, context,
      sessionKey, user.sub, user.email,
      captchaText, debug,
    );

    res.json({ success: true, result, computedFields: enrichedFields });

  } catch (err: any) {
    if (err?.name === 'CaptchaRequiredError') {
      // Park the browser slot so Phase 2 can reuse the session
      const token = `cap_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      parkedCaptchaSessions.set(token, {
        sessionKey,
        enrichedFields,
        captchaImageBase64: err.captchaImageBase64,
        expiresAt: Date.now() + 15 * 60_000,
      });
      acquired = false;  // Don't release — parked for Phase 2
      res.status(422).json({
        success: false, captchaRequired: true,
        captchaToken: token,
        captchaImageBase64: err.captchaImageBase64,
        message: 'Captcha required. Re-call with captchaToken + captchaText to complete login.',
      });
      return;
    }
    next(err);
  } finally {
    if (acquired) await browserPool.release(sessionKey);
  }
});

// ── AI Cost Analytics (Langfuse) ──────────────────────────────────────────

// Cost per million tokens by model name
const MODEL_RATES: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6':        { input: 3.00,  output: 15.00 },
  'claude-sonnet-4-5':        { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5-20251001': { input: 0.80,  output:  4.00 },
  'claude-haiku-4-5':         { input: 0.80,  output:  4.00 },
};
// Fallback by trace/observation name when model field is missing
const NAME_RATES: Record<string, { input: number; output: number }> = {
  'chat-collect':  { input: 3.00,  output: 15.00 },
  'chat-confirm':  { input: 3.00,  output: 15.00 },
  'ocr':           { input: 3.00,  output: 15.00 },
  'captcha-solve': { input: 0.80,  output:  4.00 },
};
const DEFAULT_RATE = { input: 3.00, output: 15.00 };

function tokenCost(model: string | null, name: string | null, inputTok: number, outputTok: number): number {
  const rate = (model && MODEL_RATES[model]) || (name && NAME_RATES[name]) || DEFAULT_RATE;
  return (inputTok * rate.input + outputTok * rate.output) / 1_000_000;
}

router.get('/ai-analytics', requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { langfuse: lf } = config;
    if (!lf.publicKey || !lf.secretKey) {
      return res.json({ success: true, enabled: false });
    }

    const auth      = Buffer.from(`${lf.publicKey}:${lf.secretKey}`).toString('base64');
    const base      = lf.baseUrl;
    const headers   = { Authorization: `Basic ${auth}`, Accept: 'application/json' };
    const fromTs    = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const fromParam = encodeURIComponent(fromTs);

    // Fetch observations (token-level) and traces (sessionId) in parallel
    const [obsRes, tracesRes] = await Promise.all([
      fetch(`${base}/api/public/observations?type=GENERATION&fromStartTime=${fromParam}&limit=500`, { headers }),
      fetch(`${base}/api/public/traces?fromTimestamp=${fromParam}&limit=200`, { headers }),
    ]);

    if (!obsRes.ok || !tracesRes.ok) {
      const msg = !obsRes.ok ? await obsRes.text() : await tracesRes.text();
      return res.status(502).json({ success: false, message: `Langfuse API error: ${msg.slice(0, 200)}` });
    }

    const observations: any[] = (await obsRes.json()).data    ?? [];
    const traces:       any[] = (await tracesRes.json()).data ?? [];

    // traceId → { sessionId, userId }
    const traceCtx: Record<string, { sessionId: string; userId: string }> = {};
    for (const t of traces) {
      traceCtx[t.id] = { sessionId: t.sessionId ?? 'unknown', userId: t.userId ?? '' };
    }

    // Aggregate per session and per feature
    type SessionBucket = {
      sessionId: string; userId: string;
      inputTok: number; outputTok: number; costUsd: number;
      features: Set<string>; firstSeen: string;
    };
    const sessionBuckets: Record<string, SessionBucket> = {};
    const featureBuckets: Record<string, { count: number; inputTok: number; outputTok: number; costUsd: number }> = {};

    for (const obs of observations) {
      const ctx       = traceCtx[obs.traceId] ?? { sessionId: 'unknown', userId: '' };
      const sid       = ctx.sessionId;
      const inputTok  = obs.usage?.input  ?? 0;
      const outputTok = obs.usage?.output ?? 0;
      const cost      = tokenCost(obs.model, obs.name, inputTok, outputTok);
      const feature   = obs.name ?? 'unknown';

      if (!sessionBuckets[sid]) {
        sessionBuckets[sid] = {
          sessionId: sid, userId: ctx.userId,
          inputTok: 0, outputTok: 0, costUsd: 0,
          features: new Set(), firstSeen: obs.startTime ?? '',
        };
      }
      const sb = sessionBuckets[sid];
      sb.inputTok  += inputTok;
      sb.outputTok += outputTok;
      sb.costUsd   += cost;
      sb.features.add(feature);
      if (obs.startTime && (!sb.firstSeen || obs.startTime < sb.firstSeen)) sb.firstSeen = obs.startTime;

      if (!featureBuckets[feature]) featureBuckets[feature] = { count: 0, inputTok: 0, outputTok: 0, costUsd: 0 };
      featureBuckets[feature].count++;
      featureBuckets[feature].inputTok  += inputTok;
      featureBuckets[feature].outputTok += outputTok;
      featureBuckets[feature].costUsd   += cost;
    }

    // Join with DB sessions for user_email, ins_type, quote_generated
    const sessionIds = Object.keys(sessionBuckets).filter(id => id !== 'unknown');
    type DbRow = { session_id: string; user_email: string; ins_type: string; quote_generated: boolean };
    const dbRows = sessionIds.length > 0
      ? await query<DbRow>(
          `SELECT session_id,
                  MAX(user_email) AS user_email,
                  MAX(ins_type)   AS ins_type,
                  BOOL_OR(action = 'quote_complete') AS quote_generated
           FROM audit_events
           WHERE session_id = ANY($1)
           GROUP BY session_id`,
          [sessionIds]
        )
      : [];

    const dbMap: Record<string, DbRow> = {};
    for (const r of dbRows) dbMap[r.session_id] = r;

    const quoteSessions  = dbRows.filter(r => r.quote_generated).length;
    const totalInputTok  = observations.reduce((s: number, o: any) => s + (o.usage?.input  ?? 0), 0);
    const totalOutputTok = observations.reduce((s: number, o: any) => s + (o.usage?.output ?? 0), 0);
    const totalCost      = Object.values(sessionBuckets).reduce((s, b) => s + b.costUsd, 0);

    const sessionList = Object.values(sessionBuckets)
      .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen))
      .slice(0, 100)
      .map(b => ({
        sessionId:        b.sessionId,
        userId:           b.userId,
        userEmail:        dbMap[b.sessionId]?.user_email ?? b.userId,
        insType:          dbMap[b.sessionId]?.ins_type   ?? '—',
        quoteGenerated:   dbMap[b.sessionId]?.quote_generated ?? false,
        firstSeen:        b.firstSeen,
        inputTokens:      b.inputTok,
        outputTokens:     b.outputTok,
        totalTokens:      b.inputTok + b.outputTok,
        estimatedCostUsd: b.costUsd,
        features:         Array.from(b.features),
      }));

    res.json({
      success: true,
      enabled: true,
      periodDays: 7,
      summary: {
        observationCount:  observations.length,
        sessionCount:      sessionIds.length,
        totalInputTokens:  totalInputTok,
        totalOutputTokens: totalOutputTok,
        totalTokens:       totalInputTok + totalOutputTok,
        estimatedCostUsd:  totalCost,
        avgCostPerSession: sessionIds.length  > 0 ? totalCost / sessionIds.length  : 0,
        avgCostPerQuote:   quoteSessions      > 0 ? totalCost / quoteSessions      : null,
      },
      byFeature: Object.entries(featureBuckets).map(([name, d]) => ({
        name, count: d.count,
        inputTokens: d.inputTok, outputTokens: d.outputTok,
        totalTokens: d.inputTok + d.outputTok,
        estimatedCostUsd: d.costUsd,
      })).sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd),
      sessions: sessionList,
    });
  } catch (err) {
    next(err);
  }
});

// ── Failed Quotes (manual handoff) ─────────────────────────────────────────

/**
 * Lists portal quote attempts that failed in the last 7 days and have not yet
 * been manually resolved. Admin can then complete the quote on the real portal
 * and type the premium back in via /manual-entry.
 */
router.get('/failed-quotes', requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    interface Row {
      id: string; session_id: string; user_id: string;
      portal_id: string; portal_name: string; ins_type: string;
      reg_number: string | null; vehicle_make: string | null; vehicle_model: string | null;
      premium: number | null; idv: number | null;
      quote_data: Record<string, unknown>;
      created_at: string;
    }
    const rows = await query<Row>(
      `SELECT q.*, COALESCE(u.email, u.username) AS user_email
       FROM quote_results q
       LEFT JOIN app_users u ON u.id::text = q.user_id
       WHERE q.premium IS NULL
         AND q.created_at > now() - INTERVAL '7 days'
         AND (q.quote_data->>'manuallyResolved') IS DISTINCT FROM 'true'
         AND (q.quote_data->>'dismissed') IS DISTINCT FROM 'true'
       ORDER BY q.created_at DESC
       LIMIT 100`
    );
    res.json({ success: true, failures: rows });
  } catch (err) { next(err); }
});

/** Count only — used to badge the dashboard nav. */
router.get('/failed-quotes/count', requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count FROM quote_results
       WHERE premium IS NULL
         AND created_at > now() - INTERVAL '7 days'
         AND (quote_data->>'manuallyResolved') IS DISTINCT FROM 'true'
         AND (quote_data->>'dismissed') IS DISTINCT FROM 'true'`
    );
    res.json({ success: true, count: parseInt(row?.count ?? '0', 10) });
  } catch (err) { next(err); }
});

/**
 * Admin types in a premium they obtained manually from the portal.
 * Updates quote_results, sets quote_data.manuallyResolved = true, and writes an
 * audit event so we know which quotes needed human help.
 */
router.post('/quotes/:id/manual-entry', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id }     = req.params;
    const { premium, idv, notes } = req.body as { premium?: number; idv?: number; notes?: string };

    if (typeof premium !== 'number' || premium <= 0) {
      return res.status(400).json({ success: false, message: 'premium (positive number) required' });
    }

    const row = await queryOne<{ session_id: string; user_id: string }>(
      'SELECT session_id, user_id FROM quote_results WHERE id = $1',
      [id]
    );
    if (!row) return res.status(404).json({ success: false, message: 'Quote not found' });

    await query(
      `UPDATE quote_results
       SET premium    = $2,
           idv        = COALESCE($3, idv),
           quote_data = quote_data
                       || jsonb_build_object('manuallyResolved', 'true',
                                              'manualEntryBy',    $4,
                                              'manualEntryAt',    to_jsonb(now()),
                                              'manualNotes',      COALESCE($5, ''))
       WHERE id = $1`,
      [id, premium, idv ?? null, req.user!.sub, notes ?? null]
    );

    logEvent({
      userId: req.user!.sub, userEmail: req.user!.email, sessionId: row.session_id,
      action: 'manual_quote_entry', outcome: 'success',
      meta: { quoteResultId: id, premium, idv, hasNotes: !!notes },
    } as any);

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Cookie Handoff (Phase 2) ──────────────────────────────────────────────
//
// Flow:
//  1. Admin clicks "Take Over" on a failed quote → frontend POSTs
//     /api/admin/handoff/start, gets back a handoffId
//  2. Frontend opens SSE on /api/admin/handoff/:handoffId/events
//  3. Admin opens the insurer portal in their own tab, logs in
//  4. Admin clicks the Chrome extension → extension POSTs cookies to
//     /api/admin/portal-sessions with the handoffId; backend stores the
//     session and emits a `cookies_received` event on the handoff channel
//  5. Backend automatically starts the replay using the stored session,
//     streaming each step via `replay_step` events, ending with
//     `replay_complete` or `replay_failed` / `session_expired`

interface HandoffInfo {
  userId:        string;
  portalId:      string;
  quoteResultId: string;   // quote_results row this handoff is replaying
  sessionId:     string;   // chat session, used for audit trail
  createdAt:     number;
}
const handoffs = new Map<string, HandoffInfo>();

/** Sweeper: drop handoffs older than 1 hour to keep the map small */
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, info] of handoffs) {
    if (info.createdAt < cutoff) handoffs.delete(id);
  }
}, 5 * 60 * 1000).unref?.();

/** POST /api/admin/handoff/start — create a handoff for a failed quote */
router.post('/handoff/start', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { quoteResultId } = req.body as { quoteResultId?: string };
    if (!quoteResultId) return res.status(400).json({ success: false, message: 'quoteResultId required' });

    const row = await queryOne<{ portal_id: string; session_id: string }>(
      'SELECT portal_id, session_id FROM quote_results WHERE id = $1',
      [quoteResultId]
    );
    if (!row) return res.status(404).json({ success: false, message: 'Quote not found' });

    const handoffId = `ho_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    handoffs.set(handoffId, {
      userId:        req.user!.sub,
      portalId:      row.portal_id,
      quoteResultId,
      sessionId:     row.session_id,
      createdAt:     Date.now(),
    });

    res.json({ success: true, handoffId, portalId: row.portal_id });
  } catch (err) { next(err); }
});

/** SSE channel scoped to one handoff modal */
router.get('/handoff/:handoffId/events', requireAdmin, (req: Request, res: Response) => {
  const { handoffId } = req.params;
  const info = handoffs.get(handoffId);
  if (!info || info.userId !== req.user!.sub) {
    res.status(404).end(); return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders?.();

  const channel = `handoff:${handoffId}`;
  const handler = (event: import('../session/progress').ProgressEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.type === 'replay_complete' || event.type === 'replay_failed' || event.type === 'session_expired') {
      // Close stream once the flow is done
      try { res.end(); } catch { /* already closed */ }
    }
  };

  const { onProgress, offProgress } = require('../session/progress');
  onProgress(channel, handler);

  // Initial waiting state
  res.write(`data: ${JSON.stringify({
    type: 'handoff_waiting', portalId: info.portalId, portalName: info.portalId.toUpperCase(),
    message: 'Waiting for you to log in and click the extension…', ts: Date.now(),
  })}\n\n`);

  // Heartbeat every 15 s so proxies don't kill the stream
  const hb = setInterval(() => res.write(': hb\n\n'), 15_000);

  req.on('close', () => {
    clearInterval(hb);
    offProgress(channel, handler);
  });
});

/**
 * Extension POSTs cookies here after the admin logs into the portal.
 * Body: { handoffId, portalId, cookies: [...], origins?: [...] }
 *
 * Cookies must be in Playwright's storageState format:
 *   { name, value, domain, path, expires, httpOnly, secure, sameSite }
 *
 * On success this kicks off the replay immediately so the admin sees the
 * quote run end-to-end without further clicks.
 */
router.post('/portal-sessions', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { handoffId, portalId, cookies, origins } = req.body as {
      handoffId?: string; portalId?: string;
      cookies?: any[]; origins?: any[];
    };

    if (!handoffId || !portalId || !Array.isArray(cookies)) {
      return res.status(400).json({ success: false, message: 'handoffId, portalId, cookies required' });
    }

    const info = handoffs.get(handoffId);
    if (!info || info.userId !== req.user!.sub) {
      return res.status(404).json({ success: false, message: 'handoff not found' });
    }
    if (info.portalId !== portalId) {
      return res.status(400).json({ success: false, message: `handoff is for portal ${info.portalId}, got ${portalId}` });
    }

    const storageState = { cookies, origins: origins ?? [] };

    // Mark older sessions for this (user, portal) as revoked
    await query(
      `UPDATE portal_sessions SET status = 'revoked'
       WHERE user_id = $1 AND portal_id = $2 AND status = 'active'`,
      [req.user!.sub, portalId]
    );

    const row = await queryOne<{ id: string }>(
      `INSERT INTO portal_sessions (user_id, portal_id, storage_state)
       VALUES ($1, $2, $3) RETURNING id`,
      [req.user!.sub, portalId, JSON.stringify(storageState)]
    );

    const portalSessionId = row!.id;
    const channel         = `handoff:${handoffId}`;
    const { emitProgress } = require('../session/progress');

    emitProgress(channel, {
      type: 'cookies_received', portalId, portalName: portalId.toUpperCase(),
      message: `Captured ${cookies.length} cookies — starting replay…`,
      cookieCount: cookies.length, ts: Date.now(),
    });

    logEvent({
      userId: req.user!.sub, userEmail: req.user!.email, sessionId: info.sessionId,
      action: 'cookies_received' as any, outcome: 'success',
      meta: { portalId, cookieCount: cookies.length, portalSessionId },
    } as any);

    // Kick off the replay in the background — emit progress on the same channel
    replayQuoteWithSession({
      quoteResultId: info.quoteResultId,
      portalSessionId,
      userId:        req.user!.sub,
      userEmail:     req.user!.email,
      sessionId:     info.sessionId,
      channel,
    }).catch(err => {
      console.error('[replay] background error:', err);
      emitProgress(channel, {
        type: 'replay_failed', portalId, portalName: portalId.toUpperCase(),
        message: `Replay error: ${err?.message ?? 'unknown'}`, ts: Date.now(),
      });
    });

    res.json({ success: true, portalSessionId });
  } catch (err) { next(err); }
});

/** Background replay: loads stored session, runs playbook with skipLogin=true,
 *  streams progress over the handoff channel, persists premium to quote_results. */
async function replayQuoteWithSession(opts: {
  quoteResultId: string; portalSessionId: string;
  userId: string; userEmail: string; sessionId: string;
  channel: string;
}): Promise<void> {
  const { quoteResultId, portalSessionId, userId, userEmail, sessionId, channel } = opts;
  const { emitProgress } = await import('../session/progress');
  const { runPlaybook, SessionExpiredError: SExp } = await import('../portal/playbook-runner');

  // Load the original failed quote — we need confirmedFields + portalId
  const quote = await queryOne<{
    portal_id: string; quote_data: { confirmedFields?: Record<string, string> };
  }>('SELECT portal_id, quote_data FROM quote_results WHERE id = $1', [quoteResultId]);
  if (!quote) throw new Error('Quote not found');

  const session = await queryOne<{ storage_state: any }>(
    'SELECT storage_state FROM portal_sessions WHERE id = $1', [portalSessionId]
  );
  if (!session) throw new Error('Portal session not found');

  const confirmedFields = quote.quote_data?.confirmedFields ?? {};
  const portalId        = quote.portal_id;
  const portalName      = portalId.toUpperCase();

  emitProgress(channel, {
    type: 'replay_started', portalId, portalName,
    message: 'Replaying quote with your session…', ts: Date.now(),
  });

  const sessionKey = `${sessionId}:${portalId}:replay`;
  let acquired = false;
  try {
    const { context } = await browserPool.acquire(sessionKey, session.storage_state);
    acquired = true;

    const result = await runPlaybook(
      portalId, confirmedFields, context,
      sessionId, userId, userEmail,
      undefined,   // captchaText
      false,       // debugMode
      (ev) => {
        // Re-emit each step on the handoff channel as a replay_step
        emitProgress(channel, { ...ev, type: 'replay_step' });
      },
      false,       // extractResumeState
      true,        // skipLogin ✨
    );

    // Persist new premium back to the original quote_results row
    await query(
      `UPDATE quote_results
       SET premium = $2, idv = COALESCE($3, idv),
           quote_data = quote_data
                       || jsonb_build_object('cookieHandoffReplay', 'true',
                                              'replayedAt', to_jsonb(now()),
                                              'replayedBy', $4)
       WHERE id = $1`,
      [quoteResultId, result.premium, result.idv ?? null, userId]
    );

    // Touch the portal session so we know it works
    await query(
      `UPDATE portal_sessions SET last_used_at = now() WHERE id = $1`,
      [portalSessionId]
    );

    emitProgress(channel, {
      type: 'replay_complete', portalId, portalName,
      message: result.success
        ? `✓ Premium ₹${result.premium?.toLocaleString('en-IN') ?? '—'}`
        : `Replay finished but no premium — ${result.errorMessage ?? 'unknown'}`,
      result: result as any, ts: Date.now(),
    });
  } catch (err: any) {
    if (err instanceof SExp) {
      // Mark the session expired so the UI prompts a fresh login
      await query(`UPDATE portal_sessions SET status = 'expired' WHERE id = $1`, [portalSessionId]);
      emitProgress(channel, {
        type: 'session_expired', portalId, portalName,
        message: 'Your portal session expired — please log in again and re-send cookies',
        ts: Date.now(),
      });
    } else {
      emitProgress(channel, {
        type: 'replay_failed', portalId, portalName,
        message: err?.message ?? 'Replay failed', ts: Date.now(),
      });
    }
  } finally {
    if (acquired) await browserPool.release(sessionKey);
  }
}

/** Dismiss a failed quote without entering a premium (e.g. user gave up). */
router.post('/quotes/:id/dismiss', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    await query(
      `UPDATE quote_results
       SET quote_data = quote_data || jsonb_build_object('dismissed','true','dismissedBy',$2,'dismissedAt',to_jsonb(now()))
       WHERE id = $1`,
      [id, req.user!.sub]
    );
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
