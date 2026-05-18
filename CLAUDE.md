# nytimes-auto-redeem — Claude Codebase Guide

## What this project does

Automates daily redemption of a New York Times subscription gift code obtained
through the Fairview Public Library (NJ) / BCCLS portal. A headless-but-headful
real Chrome instance navigates the library site, follows the NYT link, fills the
gift code if needed, and clicks Redeem. The whole flow runs on a daily cron job
inside Docker.

---

## Repo layout

```
redeem.js            Main script — entire automation in one file
Dockerfile           Node 20-slim + real Google Chrome + Xvfb + cron
docker-compose.yml   Runs the container; mounts ./cookies as a volume
crontab              Fires redeem.js at 06:05 ET daily via xvfb-run
update-code.sh       Interactive helper to update NYTIMES_GIFT_CODE in .env
cookies/             Runtime-only dir (gitignored): cookies, screenshots, history
package.json         Single dependency: puppeteer-real-browser ^1.4.4
```

---

## Key design decisions

### Real Chrome + Xvfb (not headless Chromium)
`puppeteer-real-browser` (`connect()`) launches a real Google Chrome binary
(installed in the Dockerfile from the official Google apt repo). The container
runs Xvfb so Chrome can open a full GUI display even with no monitor. This is
the primary anti-bot-detection strategy — NYT fingerprints headless Chromium
very reliably.

### Persistent Chrome user-data-dir
`USER_DATA_DIR` defaults to `cookies/chrome-profile`. Reusing the same profile
across daily runs keeps history, cache, and fingerprint consistent. A fresh
profile every morning looks suspicious to NYT.

### Stealth applied to every page, including new tabs
`applyStealthToPage()` is wired to `browser.on('targetcreated', ...)` so that
when the Fairview site opens the NYT link in a new tab, that tab gets the same
UA, viewport, timezone, locale, and JS-level evasions as the original page. The
old approach only patched the first page — the new tab inherited raw Puppeteer
defaults, which was the main detection hole.

### Gift code auto-extraction
The script tries to extract the gift code from the Fairview link href and page
text before falling back to `NYTIMES_GIFT_CODE` in `.env`. This means the code
can update on the library side without needing a manual `.env` edit. The
`NYTIMES_GIFT_CODE` env var is now an optional fallback, not a requirement.

### Cookie encryption
If `COOKIE_ENCRYPTION_KEY` is set, cookies are encrypted at rest with
AES-256-GCM (scrypt key derivation, random salt + IV per write). The history
log is not encrypted.

---

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NYTIMES_GIFT_CODE` | No | auto-fetched from Fairview | Gift code fallback |
| `NYTIMES_EMAIL` | No | — | NYT account email for automated login |
| `NYTIMES_PASSWORD` | No | — | NYT account password for automated login |
| `LIBRARY_CARD_NUMBER` | No | — | BCCLS patron card number |
| `LIBRARY_PIN` | No | — | BCCLS patron PIN |
| `COOKIE_ENCRYPTION_KEY` | No | — | Encrypts cookie file at rest |
| `LIBRARY_LOGIN_URL` | No | BCCLS Polaris login URL | Override login page |
| `FAIRVIEW_HOME_URL` | No | `https://fairviewlibrarynj.org/en/` | Override home page |
| `CHROME_EXECUTABLE_PATH` | No | `/usr/bin/google-chrome-stable` | System Chrome path |
| `USER_DATA_DIR` | No | `cookies/chrome-profile` | Chrome profile dir |
| `USER_AGENT_OVERRIDE` | No | — | Force a specific UA string |
| `TZ` | No | `America/New_York` | Container/cron timezone |
| `LOCALE` | No | `en-US` | Browser locale + Accept-Language |

All variables are loaded from `.env` (gitignored) by docker-compose.

---

## CLI modes

```bash
# Normal automated run
node redeem.js

# Open a visible Chrome so you can log in manually and seed cookies
node redeem.js --manual-login

# Prompt for library credentials interactively instead of reading from .env
node redeem.js --prompt-library-credentials

# Print a summary of past attempts
node redeem.js --history
```

---

## Docker workflow

```bash
docker-compose build
docker-compose up -d

# Manual login to seed cookies (run once, then automated runs use saved session)
docker-compose exec nytimes-redeem node redeem.js --manual-login

# Tail cron logs
docker-compose exec nytimes-redeem tail -f /var/log/cron.log

# Update the gift code in .env and optionally restart
./update-code.sh
```

The Dockerfile CMD dumps all relevant env vars to `/app/.env-cron` at startup
so the cron job (which runs in a sanitized environment) can source them.

---

## Functions in redeem.js

| Function | What it does |
|---|---|
| `randomDelay(min, max)` | Jittered pause to simulate human timing |
| `randomBetween(min, max)` | Uniform random float |
| `humanMouseMove(page, ...)` | Eased, jittered mouse path between two points |
| `humanClick(page, el)` | Scroll into view → human mouse move → down/up |
| `humanType(el, text)` | Type one character at a time with random delays |
| `extractCodeFromUrl(url)` | Regex extraction of gift code from a URL |
| `extractCodeFromText(text)` | Regex extraction of gift code from page text |
| `hasCookieEncryptionKey()` | Returns true if the env key is set and non-empty |
| `encryptString(plaintext)` | AES-256-GCM encrypt with random salt/IV; no-op without key |
| `decryptString(payload)` | Inverse of encryptString |
| `applyStealthToPage(page)` | Set viewport, UA, timezone, Accept-Language, JS evasions |
| `launchBrowser(opts)` | Connect via puppeteer-real-browser; wire targetcreated stealth |
| `findFirstSelector(page, selectors)` | Try selectors in order; return first match |
| `findButtonByText(page, matchers)` | Find a button/link whose text matches any matcher |
| `safeScreenshot(page, filename)` | Best-effort screenshot to cookies/ |
| `promptForLibraryCredentials()` | Readline prompt for card # and PIN |
| `loginToLibrary(page, creds)` | Navigate to BCCLS and submit login form |
| `loginToNyTimes(page)` | Navigate to NYT login, fill email + password, detect success |
| `openNyTimesFromFairview(page, browser)` | Navigate Fairview home → click NYT link → return NYT page |
| `ensureGiftCodeFilled(page)` | Fill gift code input if present and empty |
| `loadHistory()` | Read redemption-history.json or return empty structure |
| `saveHistory(history)` | Write history to disk |
| `logAttempt(success, status, code)` | Append attempt; trim to last 30; call analyzePattern |
| `analyzePattern(history)` | Print success/fail summary; warn on repeated failures |
| `loadCookies(page)` | Load (and decrypt if needed) cookies from disk into page |
| `saveCookies(page)` | Dump current page cookies to disk (encrypt if key set) |
| `redeemSubscription()` | Main flow: launch → login → navigate → check → click → log |
| `manualLogin()` | Interactive mode: open Chrome, wait for SIGINT, save cookies |
| `showHistory()` | Print formatted history report |

---

## Failure modes and status codes logged

| Status | Meaning |
|---|---|
| `SUCCESS` | Redeem button clicked and success text found |
| `ALREADY_REDEEMED` | Page says already redeemed today |
| `BOT_DETECTED` | "access denied / blocked / robot" before click |
| `BOT_DETECTED_AFTER_CLICK` | Same signals after clicking Redeem |
| `AUTH_REQUIRED` | "log in / sign in" found before reaching redeem button |
| `CODE_EXPIRED` | Invalid/expired/no-longer-valid text before click |
| `CODE_EXPIRED_AFTER_CLICK` | Same after click |
| `NO_BUTTON` | Redeem button not found on page |
| `REDEEM_UNCLICKABLE` | Button found but click failed |
| `NYTIMES_LINK_FAILED` | Could not reach NYT page from Fairview site |
| `NO_GIFT_CODE` | Gift code not found anywhere |
| `UNCLEAR` | Page loaded after click but no recognizable success/failure signal |
| `ERROR` | Unhandled exception |

Screenshots are saved to `cookies/` on any failure (and on success).

---

## What NOT to do

- Do not commit `.env`, `cookies/`, or `*.png` — all are gitignored.
- Do not switch back to `puppeteer-extra` + the stealth plugin. The current
  `puppeteer-real-browser` approach using real Chrome + Xvfb is the reason bot
  detection is bypassed; reverting would likely break it.
- Do not set `headless: true` in `launchBrowser()` — NYT detects headless mode.
- Do not apply stealth only to the first page; `targetcreated` must stay wired
  so new tabs (the NYT tab) also get the fingerprint patch.
