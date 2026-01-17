# nytimes-auto-redeem

Automates redemption of a New York Times subscription gift code. It runs a
headless browser with anti-bot measures, reuses stored login cookies, and
records each attempt with screenshots and history.

## Purpose

The goal is to redeem a time-limited gift code reliably without manual steps:

- Log in to the Fairview/BCCLS library portal (optional when cookies exist).
- Visit the Fairview Library site and open the NY Times redemption link.
- Detect common failure modes (auth required, bot detection, expired code).
- Click the redeem/claim button when available.
- Save cookies and log results to track success over time.

## How it works

- `redeem.js` is the main script. It uses `puppeteer-extra` with the stealth
  plugin to reduce bot detection.
- Cookies and redemption history are stored under `cookies/` (mounted as a
  volume in Docker).
- The script does not go directly to `nytimes.com`; it follows the Fairview
  Library → NY Times link.
- A cron job inside the container runs the redemption daily.

## Functions and what they do

From `redeem.js`:

- `randomDelay(min, max)`: adds jittered pauses to appear more human.
- `loadHistory()`: reads `cookies/redemption-history.json` or creates a new
  history object when missing.
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
- `openNyTimesFromFairview(page, browser)`: opens the NY Times link from the
  Fairview Library site.
- `ensureGiftCodeFilled(page)`: fills the gift code if the page asks for it.
- `redeemSubscription()`: main flow that launches the browser, follows the
  Fairview → NY Times path, checks for failure states, clicks the redeem button,
  and logs the result.
- `manualLogin()`: opens a visible browser so you can log in and save cookies.
- `showHistory()`: prints a summary of past attempts.

## Security precautions

Sensitive values are read from environment variables via a `.env` file instead
of hard-coding them:

- `NYTIMES_GIFT_CODE`: prevents the gift code from being committed.
- `LIBRARY_CARD_NUMBER`: library card number for the Fairview/BCCLS login.
- `LIBRARY_PIN`: library PIN/password for the Fairview/BCCLS login.

Optional URL overrides:

- `LIBRARY_LOGIN_URL`: defaults to the Fairview/BCCLS login page.
- `FAIRVIEW_HOME_URL`: defaults to `https://fairviewlibrarynj.org/en/`.

The `.env` file is loaded by Docker (`docker-compose.yml`) and should stay out
of version control to avoid leaks of paid subscription codes.

### `COOKIE_ENCRYPTION_KEY`

This variable holds a secret used to encrypt cookies before writing them to
disk. The purpose is to protect the saved session cookies at rest (in
`cookies/nytimes-cookies.json`) so that a leaked file is harder to abuse. Keep
this value private and rotate it if you suspect exposure.

To use it:

1. Generate a random key and add it to `.env`:

```
COOKIE_ENCRYPTION_KEY=your_long_random_value
```

Example key generation:

```
openssl rand -base64 32
```

2. Restart the container or re-run the script so cookies are re-saved.
   If you already have plaintext cookies, the next save will rewrite them
   encrypted. You can also delete `cookies/nytimes-cookies.json` and run
   `--manual-login` to create an encrypted file from scratch.

Notes:

- If the cookie file is encrypted and `COOKIE_ENCRYPTION_KEY` is missing or
  wrong, cookies cannot be loaded.
- The history log is not encrypted (only the cookie file is).

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
            | load cookies + library login |
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
    -> screenshot + log FAIL
    -> manual-login suggested
                           |
                           v
               +------------------------+
               | find & click redeem    |
               +-----------+------------+
                           |
               +-----------+------------+
               | result checks          |
               +-----+---------+--------+
                     |         |
        success -----+         +---- unclear/blocked/expired
        -> save cookies              -> screenshot + log FAIL
        -> log SUCCESS
```

## Run locally (optional)

```
npm install
NYTIMES_GIFT_CODE=... LIBRARY_CARD_NUMBER=... LIBRARY_PIN=... node redeem.js
```

## Run with Docker

```
docker-compose build
docker-compose up -d
```

Manual login (to save cookies):

```
docker-compose exec nytimes-redeem node redeem.js --manual-login
```
Then log in to the BCCLS portal, open the Fairview site, and click the NY Times
icon before pressing `Ctrl+C` to save cookies.

Prompt for library credentials (avoids storing in `.env`):

```
docker-compose exec nytimes-redeem node redeem.js --prompt-library-credentials
```

Show history:

```
docker-compose exec nytimes-redeem node redeem.js --history
```

## Files at a glance

- `redeem.js`: main automation script and helper functions.
- `Dockerfile`: builds a Node + Chromium environment and installs cron.
- `docker-compose.yml`: runs the container and mounts `cookies/`.
- `crontab`: daily schedule for redemption.
- `update-code.sh`: helper to update `NYTIMES_GIFT_CODE` in `.env`.
- `cookies/`: persisted cookies, logs, and screenshots.
