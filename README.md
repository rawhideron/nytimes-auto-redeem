# nytimes-auto-redeem

Automates redemption of a New York Times subscription gift code. It runs a
headful real Chrome browser with anti-bot measures, logs in to both the
Fairview/BCCLS library portal and NY Times automatically, and records each
attempt with screenshots and history.

## Purpose

The goal is to redeem a time-limited gift code reliably without manual steps:

- Log in to NY Times (email/password, with Google SSO fallback).
- Log in to the Fairview/BCCLS library portal (when credentials are set).
- Visit the Fairview Library site and follow the NY Times redemption link.
- Detect common failure modes (bot detection, auth required, expired code).
- Click the Redeem button when available.
- Save cookies and log results to track success over time.

## How it works

- `redeem.js` is the main script. It uses `puppeteer-real-browser` with real
  Google Chrome (not bundled Chromium) running headful inside Xvfb to defeat
  NYT bot detection.
- Cookies and redemption history are stored under `cookies/` (mounted as a
  volume in Docker). The Chrome user-data-dir is also persisted there so the
  browser profile stays consistent across daily runs.
- The script does not go directly to `nytimes.com`; it follows the Fairview
  Library → NY Times link so the gift code is picked up automatically.
- A cron job inside the container runs the redemption daily at 6:05 AM ET.

## Functions and what they do

From `redeem.js`:

- `randomDelay(min, max)`: adds jittered pauses to appear more human.
- `humanMouseMove(page, ...)`: moves the mouse along a noisy curved path.
- `humanClick(page, el)`: scrolls into view, moves mouse naturally, clicks.
- `humanType(el, text)`: types one character at a time with random delays.
- `loadHistory()`: reads `cookies/redemption-history.json` or initialises one.
- `saveHistory(history)`: persists history to disk.
- `logAttempt(success, status, codeUsed)`: records success/failure, detects
  code changes, and keeps only the last 30 attempts.
- `analyzePattern(history)`: prints a quick summary and warns on repeated
  failures.
- `loadCookies(page)`: loads cookies from `cookies/nytimes-cookies.json` into
  the browser session (decrypts when `COOKIE_ENCRYPTION_KEY` is set).
- `saveCookies(page)`: writes the current browser cookies to disk (encrypts
  when `COOKIE_ENCRYPTION_KEY` is set).
- `loginToLibrary(page, credentials)`: signs in to the Fairview/BCCLS portal.
- `loginToNyTimes(page)`: logs in to NY Times using email/password; falls back
  to "Continue with Google" if email/password fails or the account is Google
  SSO only.
- `openNyTimesFromFairview(page, browser)`: opens the NY Times link from the
  Fairview Library site.
- `ensureGiftCodeFilled(page)`: fills the gift code if the page asks for it.
- `redeemSubscription()`: main flow — launch browser, log in to NYT and
  library, follow Fairview → NY Times path, check for failure states, click
  Redeem, and log the result.
- `manualLogin()`: opens a visible Chrome with two tabs (BCCLS login and NYT
  login) so you can seed both sessions at once; Ctrl+C saves cookies from all
  relevant domains.
- `showHistory()`: prints a summary of past attempts.

## Security precautions

Sensitive values are read from environment variables via a `.env` file:

- `NYTIMES_EMAIL`: NY Times account email for automated login.
- `NYTIMES_PASSWORD`: NY Times account password. If the account uses Google
  SSO only, the script falls back to clicking "Continue with Google"
  automatically using the existing Chrome session.
- `LIBRARY_CARD_NUMBER`: library card number for the Fairview/BCCLS login.
- `LIBRARY_PIN`: library PIN/password for the Fairview/BCCLS login.
- `NYTIMES_GIFT_CODE`: optional fallback gift code; normally auto-fetched from
  the Fairview site.

Optional URL overrides:

- `LIBRARY_LOGIN_URL`: defaults to the Fairview/BCCLS login page.
- `FAIRVIEW_HOME_URL`: defaults to `https://fairviewlibrarynj.org/en/`.
- `CHROME_EXECUTABLE_PATH`: path to a Chrome binary (set automatically in the
  Docker image to `/usr/bin/google-chrome-stable`).
- `USER_DATA_DIR`: path to the Chrome user data directory (defaults to
  `cookies/chrome-profile`).

The `.env` file should stay out of version control.

### `COOKIE_ENCRYPTION_KEY`

Optional secret used to encrypt `cookies/nytimes-cookies.json` at rest with
AES-256-GCM. Generate a key with:

```
openssl rand -base64 32
```

Add it to `.env` and restart the container. The next cookie save will rewrite
the file encrypted. The history log is not encrypted.

## Diagram (success + failure paths)

```
                 +-----------------------+
                 | cron / manual run     |
                 +-----------+-----------+
                             |
                             v
                   +-----------------+
                   | redeem.js start |
                   +--------+--------+
                            |
                            v
            +------------------------------+
            | load cookies                 |
            | NYT login (email/pw or SSO)  |
            | library login (BCCLS)        |
            | open Fairview NY Times link  |
            +--------------+---------------+
                            |
                 +----------+----------+
                 | page checks         |
                 | (bot/auth/expired)  |
                 +----+----+----+------+
                      |    |    |
     bot detected ----+    |    +---- code invalid/expired
     -> screenshot         |         -> screenshot + log FAIL
     + log FAIL            |
                           |
    auth required --------+
    -> re-login + retry
    (or log FAIL if no creds)
                           |
                           v
               +------------------------+
               | find & click Redeem    |
               +-----------+------------+
                           |
               +-----------+------------+
               | result checks          |
               +-----+---------+--------+
                     |         |
        success -----+         +---- login wall / blocked / expired
        -> save cookies              -> re-auth + retry or log FAIL
        -> log SUCCESS
```

## First-time setup (seed the Chrome profile)

Run `--manual-login` once to establish both your library and NYT sessions.
This opens Chrome with two tabs and requires X11 forwarding so you can see
and interact with the browser:

```bash
# Allow Docker to use your host display
xhost +local:docker

docker run --rm \
  -e DISPLAY=:1 \
  -e XAUTHORITY=/tmp/.Xauthority \
  -e TZ=America/New_York \
  --env-file .env \
  --user "$(id -u):$(id -g)" \
  -v /tmp/.X11-unix:/tmp/.X11-unix \
  -v "$XAUTHORITY:/tmp/.Xauthority:ro" \
  -v "$(pwd)/cookies:/app/cookies" \
  nytimes-redeem node redeem.js --manual-login
```

Two tabs open:
- **Tab 1** — Fairview/BCCLS login: sign in with your library card.
- **Tab 2** — NY Times login: sign in to your NYT account.

When both are done, press **Ctrl+C** in the terminal to save cookies from all
domains and exit.

## Run with Docker

```bash
# Build the image
docker build -t nytimes-redeem .

# Start the container (runs cron at 6:05 AM ET daily)
docker run -d \
  --name nytimes-redeem \
  --restart unless-stopped \
  -e TZ=America/New_York \
  --env-file .env \
  -v "$(pwd)/cookies:/app/cookies" \
  nytimes-redeem

# Watch cron logs
docker logs -f nytimes-redeem

# Run a manual test (mirrors exactly what cron does)
docker exec nytimes-redeem bash -c \
  '. /app/.env-cron && xvfb-run -a --server-args="-screen 0 1440x900x24" node /app/redeem.js'

# Show redemption history
docker exec nytimes-redeem bash -c \
  '. /app/.env-cron && node /app/redeem.js --history'

# Stop / restart
docker stop nytimes-redeem
docker restart nytimes-redeem

# Update .env credentials and restart
docker restart nytimes-redeem
```

> **Note:** `docker-compose` v1 (the system package on some distros) has a
> known incompatibility with newer Docker daemons. Use the `docker` commands
> above directly.

## Run locally (optional)

```bash
npm install
NYTIMES_EMAIL=... NYTIMES_PASSWORD=... \
LIBRARY_CARD_NUMBER=... LIBRARY_PIN=... \
node redeem.js
```

## Files at a glance

- `redeem.js`: main automation script and all helper functions.
- `Dockerfile`: Node 20-slim + real Google Chrome + Xvfb + cron.
- `docker-compose.yml`: reference compose config (use `docker` CLI directly if compose v1 is broken).
- `crontab`: daily schedule — fires `redeem.js` at 06:05 ET via `xvfb-run`.
- `update-code.sh`: helper to update `NYTIMES_GIFT_CODE` in `.env`.
- `cookies/`: persisted cookies, Chrome profile, logs, and screenshots (gitignored).
