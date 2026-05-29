import * as fs   from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ── Types ──────────────────────────────────────────────────────────────────

export interface DiscoveredField {
  id:          string;
  name:        string;
  type:        string;
  label:       string;
  selector:    string;  // best CSS selector to use in playbook
  options?:    { value: string; text: string }[];
}

export interface DiscoveredButton {
  id:       string;
  text:     string;
  selector: string;
}

export interface DiscoveredLink {
  text: string;
  href: string;
}

export interface StepSnapshot {
  step_id:        string;
  url:            string;
  page_title:     string;
  structure_hash: string;    // sha256 of sorted field ids — used to detect changes
  form_fields:    DiscoveredField[];
  buttons:        DiscoveredButton[];
  nav_links:      DiscoveredLink[];
  screenshot_file: string;   // filename inside profile dir
  screenshot_base64?: string; // included on write, omitted on read (loaded separately)
}

export interface PortalProfile {
  portal_id:     string;
  discovered_at: string;
  login_verified: boolean;
  // Sequence of actions used to navigate through the quote flow during discovery.
  // Re-run this to refresh the profile.
  nav_steps: Array<{
    label:   string;
    action:  'click_text' | 'click_selector' | 'navigate' | 'select_option';
    value:   string;
    option?: string;  // for select_option: the option value to select
  }>;
  steps:       StepSnapshot[];
}

// ── Storage ────────────────────────────────────────────────────────────────

const PROFILES_DIR = path.join(__dirname, 'profiles');

export function getProfileDir(portalId: string): string {
  return path.join(PROFILES_DIR, portalId);
}

export function getScreenshotPath(portalId: string, filename: string): string {
  return path.join(getProfileDir(portalId), filename);
}

export function loadProfile(portalId: string): PortalProfile | null {
  const file = path.join(getProfileDir(portalId), 'profile.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as PortalProfile;
}

export function saveProfile(
  portalId:    string,
  profile:     PortalProfile,
  screenshots: Map<string, Buffer>,  // step_id → PNG buffer
): void {
  const dir = getProfileDir(portalId);
  fs.mkdirSync(dir, { recursive: true });

  // Write each screenshot as a PNG file, strip base64 from the JSON
  const cleanSteps = profile.steps.map(step => {
    const { screenshot_base64, ...rest } = step;
    if (screenshot_base64) {
      const buf = Buffer.from(screenshot_base64, 'base64');
      fs.writeFileSync(path.join(dir, step.screenshot_file), buf);
    } else if (screenshots.has(step.step_id)) {
      fs.writeFileSync(path.join(dir, step.screenshot_file), screenshots.get(step.step_id)!);
    }
    return rest;
  });

  const profileToSave = { ...profile, steps: cleanSteps };
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(profileToSave, null, 2));
}

export function listProfiles(): string[] {
  if (!fs.existsSync(PROFILES_DIR)) return [];
  return fs.readdirSync(PROFILES_DIR)
    .filter(f => fs.existsSync(path.join(PROFILES_DIR, f, 'profile.json')));
}

// ── Staleness check ────────────────────────────────────────────────────────
// Call this after a real form navigation to detect if the portal changed.
// Returns step IDs whose structure_hash no longer matches the profile.

export interface StalenessResult {
  step_id:      string;
  stored_hash:  string;
  current_hash: string;
  changed:      boolean;
}

export function checkStaleness(
  portalId:     string,
  liveSnapshots: { step_id: string; field_ids: string[] }[],
): StalenessResult[] {
  const profile = loadProfile(portalId);
  if (!profile) return [];

  return liveSnapshots.map(live => {
    const stored = profile.steps.find(s => s.step_id === live.step_id);
    const currentHash = hashFieldIds(live.field_ids);
    return {
      step_id:     live.step_id,
      stored_hash: stored?.structure_hash ?? '',
      current_hash: currentHash,
      changed:     stored?.structure_hash !== currentHash,
    };
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function hashFieldIds(fieldIds: string[]): string {
  return crypto.createHash('sha256')
    .update([...fieldIds].sort().join(','))
    .digest('hex')
    .slice(0, 12);
}
