// Alert Insurance — Session Capture popup script.
//
// Workflow:
//   1. Admin opens the insurer portal in another tab and logs in normally.
//   2. Admin clicks this extension icon, picks the portal, pastes the
//      handoff ID from the dashboard modal, clicks "Send Session".
//   3. This script grabs every cookie chrome can see for the portal's
//      cookie store (including HttpOnly) and POSTs them to the backend.
//   4. Backend kicks off the quote replay automatically.

// Domain glob per portalId — what chrome.cookies.getAll filters by
const PORTAL_DOMAINS = {
  uiic:        '.uiic.in',
  iciclombard: '.iciclombard.com',
  tataaig:     '.tataaig.com',
  bajaj:       '.bajajallianz.com',
  hdfcergo:    '.hdfcergo.com',
  newindia:    '.newindia.co.in',
};

// Origin used in the Playwright storageState block (for localStorage capture later)
const PORTAL_ORIGINS = {
  uiic:        'https://www.uiic.in',
  iciclombard: 'https://www.iciclombard.com',
  tataaig:     'https://www.tataaig.com',
  bajaj:       'https://www.bajajallianz.com',
  hdfcergo:    'https://www.hdfcergo.com',
  newindia:    'https://www.newindia.co.in',
};

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

// Restore settings + last-used handoff
chrome.storage.local.get(['apiUrl', 'apiToken', 'lastPortal', 'lastHandoff'], (cfg) => {
  $('apiUrl').value     = cfg.apiUrl   || 'https://alertchat-production.up.railway.app';
  $('apiToken').value   = cfg.apiToken || '';
  if (cfg.lastPortal)   $('portalId').value  = cfg.lastPortal;
  if (cfg.lastHandoff)  $('handoffId').value = cfg.lastHandoff;
});

$('settingsToggle').addEventListener('click', () => {
  $('settings').classList.toggle('open');
});

$('saveSettings').addEventListener('click', () => {
  chrome.storage.local.set({
    apiUrl:   $('apiUrl').value.trim().replace(/\/$/, ''),
    apiToken: $('apiToken').value.trim(),
  }, () => {
    showStatus('ok', 'Settings saved.');
  });
});

function showStatus(kind, msg) {
  statusEl.className = `status ${kind}`;
  statusEl.textContent = msg;
}

// Convert chrome.cookies entry → Playwright storageState cookie shape.
// Differences: Playwright wants `sameSite` capitalised, and `expires`
// in seconds (already is in Chrome), and `session` cookies as -1.
function toPlaywrightCookie(c) {
  const sameSiteMap = {
    no_restriction: 'None',
    lax:            'Lax',
    strict:         'Strict',
    unspecified:    'None',
  };
  return {
    name:     c.name,
    value:    c.value,
    domain:   c.domain,
    path:     c.path,
    expires:  c.session ? -1 : (c.expirationDate ?? -1),
    httpOnly: !!c.httpOnly,
    secure:   !!c.secure,
    sameSite: sameSiteMap[c.sameSite] ?? 'Lax',
  };
}

$('sendBtn').addEventListener('click', async () => {
  const portalId  = $('portalId').value;
  const handoffId = $('handoffId').value.trim();
  const { apiUrl, apiToken } = await chrome.storage.local.get(['apiUrl', 'apiToken']);

  if (!apiUrl || !apiToken) {
    showStatus('err', 'Settings missing. Open Settings and paste backend URL + token.');
    return;
  }
  if (!handoffId.startsWith('ho_')) {
    showStatus('err', 'Paste the handoff ID from the dashboard modal (starts with "ho_").');
    return;
  }

  const domain = PORTAL_DOMAINS[portalId];
  if (!domain) { showStatus('err', `Unknown portal: ${portalId}`); return; }

  $('sendBtn').disabled = true;
  showStatus('info', `Reading cookies for ${domain}…`);

  try {
    const rawCookies = await chrome.cookies.getAll({ domain });
    if (rawCookies.length === 0) {
      showStatus('err', `No cookies found for ${domain}. Make sure you're logged in to the portal in another tab.`);
      $('sendBtn').disabled = false;
      return;
    }

    const cookies = rawCookies.map(toPlaywrightCookie);

    showStatus('info', `Sending ${cookies.length} cookies to Alert Insurance…`);

    const res = await fetch(`${apiUrl}/api/admin/portal-sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        handoffId, portalId,
        cookies,
        origins: [{ origin: PORTAL_ORIGINS[portalId], localStorage: [] }],
      }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.success) {
      const msg = data.message || `HTTP ${res.status}`;
      showStatus('err', `Failed: ${msg}`);
      $('sendBtn').disabled = false;
      return;
    }

    chrome.storage.local.set({ lastPortal: portalId, lastHandoff: handoffId });

    showStatus('ok', `✓ Sent ${cookies.length} cookies. Switch back to the dashboard to watch the replay.`);
    setTimeout(() => window.close(), 2_500);
  } catch (err) {
    showStatus('err', `Error: ${err?.message || err}`);
    $('sendBtn').disabled = false;
  }
});
