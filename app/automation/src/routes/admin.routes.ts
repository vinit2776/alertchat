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

let _ai: Anthropic | null = null;
function getAI() {
  if (!_ai) _ai = new Anthropic({ apiKey: config.anthropicApiKey });
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
router.get('/companies', requireAdmin, async (_req, res, next) => {
  try {
    res.json({ success: true, companies: await getAllCompanies() });
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

export default router;
