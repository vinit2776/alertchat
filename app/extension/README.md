# Alert Insurance — Session Capture (Chrome Extension)

A tiny Manifest V3 Chrome extension that captures your logged-in insurer
portal session and hands it to the Alert Insurance automation backend so a
failed quote can be replayed without a fresh login.

## One-time install (~30 s)

1. Open `chrome://extensions` in Chrome / Edge / Brave / Arc
2. Toggle **Developer mode** on (top-right)
3. Click **Load unpacked**
4. Select this folder (`app/extension`)
5. Pin the extension to the toolbar (puzzle-piece icon → pin)

## First-time configuration

1. Click the extension icon → **⚙️ Settings**
2. **Backend URL**: leave default unless you changed Railway domain
3. **API Token**: paste your JWT from the dashboard (DevTools → Application → Local Storage → `chi_token`)
4. Click **Save settings**

These persist via `chrome.storage.local` and never leave your browser.

## Per-use flow

The Alert Insurance dashboard kicks the loop off — you only touch this
extension once per quote.

1. Quote fails → red "🚨 N failed" badge in dashboard
2. Click failed quote → **Take Over** → modal shows a **Handoff ID** (`ho_xxxx_xxxxxxxx`)
3. Modal opens the portal in a new tab — log in as usual (your normal username/password/captcha)
4. Click the extension icon
5. Verify the portal dropdown matches the insurer
6. Paste the Handoff ID
7. Click **📤 Send Session**
8. Switch back to the dashboard — the replay starts automatically and streams progress

## Permissions explained

| Permission | Why |
|---|---|
| `cookies` | Read HttpOnly + Secure cookies that `document.cookie` can't see |
| `storage` | Remember your backend URL + token between popup opens |
| `activeTab` | Standard MV3 boilerplate; we don't actually use page content |
| `host_permissions` for portal domains | Required for `chrome.cookies.getAll({ domain })` |
| `host_permissions` for Railway domain | Required to `fetch()` the backend |

No content scripts. No background workers. Nothing runs unless you click the
icon.

## Security model

- Cookies are sent over HTTPS to your own backend only
- Token is stored in `chrome.storage.local`, never synced to Google
- The backend validates the JWT and your admin role before accepting cookies
- The Handoff ID is single-use and tied to a specific failed quote
- Stored portal sessions can be revoked from the dashboard at any time
