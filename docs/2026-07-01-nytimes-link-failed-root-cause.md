# NYTIMES_LINK_FAILED investigation — 2026-07-01

## Symptom

`redemption-history.json` shows the failure signature changed on **2026-06-28**:
before that, failures were mostly `UNCLEAR` (ambiguous result on the redemption
page). Starting 2026-06-28, 3 of the last 4 runs failed with
`NYTIMES_LINK_FAILED` — the script couldn't get a working NY Times tab open at
all, including today (2026-07-01).

Today's failure log (from `docker logs nytimes-redeem`):

```
🌐 Navigating to Fairview Library site...
🔎 NY Times link not on home page, checking Online/Services nav...
⚠️  Could not navigate directly via href — falling back to clicking the tile...
⚠️  No navigation after click — retrying with JS dispatch...
❌ ERROR: NY Times redemption page did not open.
```

## What I checked first (and ruled out)

The user asked whether the script scrolls down to find an NY Times icon
instead of using a dropdown menu. Checked `redeem.js` — there is no dropdown
logic anywhere (`grep -ni "dropdown"` — zero matches). Link discovery is a
DOM query (`querySelectorAll('a')` matched by text or `href` containing
`nytimes.com`), which works regardless of scroll position — scrolling is only
used cosmetically before a click, via `scrollIntoView` in `humanClick`. This
part of the code is not the problem.

Fetched the live Fairview "Online" page directly:

```
curl -sL <fairview /online/ page>
```

Confirmed the NY Times card's "Learn More" link resolves to:
```
https://www.nytimes.com/subscription/promotions/lp3FURL.html?campaignId=6Y9QR&gift_code=24170f51d678a288
```

`curl -L` on that exact URL redirects cleanly in ~0.4s to
`https://www.nytimes.com/subscription/redeem?campaignId=...&gift_code=...`
with a 200 — so the destination URL itself is not broken, redirecting, or slow
at the plain-HTTP level.

## Root cause #1 (primary): stale Docker deployment

Compared the `redeem.js` running inside the live container against git
history:

```
docker exec nytimes-redeem cat /app/redeem.js  →  md5sum
git show 49cf722:redeem.js                     →  md5sum
```

**These are byte-for-byte identical.** The container's image was built on
**2026-06-17** (`docker inspect nytimes-redeem --format '{{.Created}}'`) and
has never been rebuilt since, despite two more commits landing on `redeem.js`
afterward:

- `debb544` — "Fix race condition in NYTimes navigation timeouts" (2026-06-29)
- an uncommitted working-tree edit changing `FAIRVIEW_HOME_URL`

**`debb544` has never actually run in production.** Every cron run since
Jun 17 — including every `NYTIMES_LINK_FAILED` since Jun 28 — executed the
pre-fix code, which still has the exact race condition that commit's own
message describes:

```diff
-await newPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
 resolve(newPage);
```

The deployed (stale) code calls `waitForNavigation` on the new tab *after*
already capturing it via `targetcreated`. If the tab's initial navigation has
already completed (the common case for a fast-loading or already-failed page),
this call waits for a *second* navigation event that never arrives, and blocks
until its own 45s/20s internal timeout — which races against, and often
outlasts, the outer 60s/20s `Promise.race` timeouts in the caller. That
produces exactly the observed sequence: tile found and clicked, new tab
opens, then "No navigation after click" / final timeout.

This is **not a failed fix** — it's a real, correct fix that was authored,
committed, and then never deployed. Conclusion: don't write a 4th
navigation-hack; ship the 3rd one that's already been written.

## Root cause #2 (secondary, already being fixed): wrong homepage URL

```
curl -L https://fairviewlibrarynj.org/en/
  → redirects to https://fairviewlibrarynj.org/english-conversationeslon-march-12-2026-at-504-pm/

curl -L https://fairviewlibrarynj.org/
  → 200, no redirect, actual homepage
```

Fairview's site was restructured; the old default `FAIRVIEW_HOME_URL`
(`.../en/`) no longer lands on the homepage — it 301s to an unrelated blog
post (a WordPress slug-matching fluke). The script *survives* this today only
because of its "Online nav" fallback (clicking the nav bar's "Online" link,
which exists site-wide), so this bug alone didn't cause today's failure — but
it's fragile and worth fixing. The user already has this fixed, uncommitted,
in the working tree:

```diff
-const FAIRVIEW_HOME_URL = process.env.FAIRVIEW_HOME_URL || 'https://fairviewlibrarynj.org/en/';
+const FAIRVIEW_HOME_URL = process.env.FAIRVIEW_HOME_URL || 'https://fairviewlibrarynj.org/';
```

Verified this points straight at the real homepage with zero redirects.

## Proposed fix (no new code required)

1. Commit the pending `FAIRVIEW_HOME_URL` change.
2. Rebuild the Docker image: `docker build -t nytimes-redeem .`
3. Restart the container from the new image, preserving the same bind mount
   and env vars it currently uses:
   - Mount: `./cookies` → `/app/cookies`
   - Env: `NYTIMES_EMAIL`, `NYTIMES_PASSWORD`, `LIBRARY_CARD_NUMBER`,
     `LIBRARY_PIN`, `TZ=America/New_York`, restart policy
     `unless-stopped`
4. Watch the next cron run (06:05 ET) or trigger a manual test run per the
   documented workflow in `CLAUDE.md` to confirm `debb544`'s fix actually
   resolves the timeout now that it's deployed.

**Not yet done** — awaiting confirmation before rebuilding/restarting the
live container, since that's a production-affecting action.
