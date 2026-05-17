// redeem.js — NY Times redemption via Fairview Library
//
// This rewrite addresses bot detection by:
//   1. Using `puppeteer-real-browser` (real Chrome + stealth patches built-in)
//      instead of bundled Chromium with the stealth plugin.
//   2. Applying browser fingerprint setup (UA, viewport, timezone, locale, headers,
//      and JS-level evasions) to BOTH the original page AND the new tab that
//      opens when the Fairview site links out to NY Times. The old script
//      configured only the first page, so the new tab arrived at NYT looking
//      like a default Puppeteer instance — the single biggest detection hole.
//   3. Running headful inside Xvfb (set up in the Dockerfile / crontab). Headful
//      Chrome is dramatically harder to detect than `headless: 'new'`.
//   4. Reusing a persistent Chrome user-data-dir so the profile, history, and
//      fingerprint stay consistent across daily runs (a fresh profile every
//      morning looks suspicious to NYT).
//   5. Real mouse movement before clicks and variable typing delays.

const { connect } = require('puppeteer-real-browser');

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const COOKIES_DIR = path.join(__dirname, 'cookies');
const COOKIES_PATH = path.join(COOKIES_DIR, 'nytimes-cookies.json');
const LOG_PATH = path.join(COOKIES_DIR, 'redemption-history.json');
const SCREENSHOT_DIR = COOKIES_DIR;
const USER_DATA_DIR = process.env.USER_DATA_DIR || path.join(COOKIES_DIR, 'chrome-profile');

let giftCode = process.env.NYTIMES_GIFT_CODE || null;
const COOKIE_ENCRYPTION_KEY = process.env.COOKIE_ENCRYPTION_KEY;
const LIBRARY_CARD_NUMBER = process.env.LIBRARY_CARD_NUMBER;
const LIBRARY_PIN = process.env.LIBRARY_PIN;
const CHROME_EXECUTABLE_PATH = process.env.CHROME_EXECUTABLE_PATH;
const LIBRARY_LOGIN_URL = process.env.LIBRARY_LOGIN_URL ||
    'https://catalog.bccls.org/polaris/logon.aspx?ctx=37.1033.0.0.6';
const FAIRVIEW_HOME_URL = process.env.FAIRVIEW_HOME_URL || 'https://fairviewlibrarynj.org/en/';
const TIMEZONE = process.env.TZ || 'America/New_York';
const LOCALE = process.env.LOCALE || 'en-US';


const CLI_ARGS = new Set(process.argv.slice(2));
const SHOULD_PROMPT_LIBRARY_CREDENTIALS = CLI_ARGS.has('--prompt-library-credentials');

// --------------------------------------------------------------------------
// Humanization helpers
// --------------------------------------------------------------------------

function randomDelay(min = 1000, max = 3000) {
    const ms = Math.random() * (max - min) + min;
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
    return Math.random() * (max - min) + min;
}

// Move the mouse along a slightly noisy path between two points instead of
// teleporting. NY Times (and most fingerprinters) look for instant cursor
// jumps as a strong bot signal.
async function humanMouseMove(page, fromX, fromY, toX, toY) {
    const steps = Math.floor(randomBetween(15, 30));
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        // Ease-in-out so motion isn't linear
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const jitterX = randomBetween(-2, 2);
        const jitterY = randomBetween(-2, 2);
        const x = fromX + (toX - fromX) * eased + jitterX;
        const y = fromY + (toY - fromY) * eased + jitterY;
        await page.mouse.move(x, y);
        await randomDelay(8, 22);
    }
}

async function humanClick(page, elementHandle) {
    if (!elementHandle) return false;
    try {
        await elementHandle.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
        await randomDelay(200, 500);
        const box = await elementHandle.boundingBox();
        if (box) {
            const targetX = box.x + box.width / 2 + randomBetween(-box.width / 6, box.width / 6);
            const targetY = box.y + box.height / 2 + randomBetween(-box.height / 6, box.height / 6);
            // Start from a "natural" location near the current viewport center.
            const startX = randomBetween(200, 800);
            const startY = randomBetween(150, 500);
            await humanMouseMove(page, startX, startY, targetX, targetY);
            await randomDelay(80, 220);
            await page.mouse.down();
            await randomDelay(40, 110);
            await page.mouse.up();
            return true;
        }
        await elementHandle.click({ delay: randomBetween(40, 90) });
        return true;
    } catch (error) {
        try {
            await elementHandle.evaluate(el => el.click());
            return true;
        } catch (innerError) {
            return false;
        }
    }
}

async function humanType(elementHandle, text) {
    if (!elementHandle) return;
    for (const ch of text) {
        await elementHandle.type(ch, { delay: 0 });
        await randomDelay(60, 180);
    }
}

// --------------------------------------------------------------------------
// Gift code extraction helpers
// --------------------------------------------------------------------------

function extractCodeFromUrl(url) {
    const patterns = [
        /[?&](?:gift_?)?code=([A-Za-z0-9\-]{8,})/i,
        /\/(?:gift|passes)\/([A-Za-z0-9\-]{8,})/i,
    ];
    for (const p of patterns) {
        const m = url.match(p);
        if (m) return m[1];
    }
    return null;
}

function extractCodeFromText(text) {
    const patterns = [
        /(?:gift|access|promo)\s+code[:\s]+([A-Z0-9]{8,})/i,
        /\bcode[:\s]+([A-Z0-9]{12,})\b/i,
    ];
    for (const p of patterns) {
        const m = text.match(p);
        if (m) return m[1];
    }
    return null;
}

// --------------------------------------------------------------------------
// Cookie encryption (unchanged from upstream)
// --------------------------------------------------------------------------

function hasCookieEncryptionKey() {
    return typeof COOKIE_ENCRYPTION_KEY === 'string' && COOKIE_ENCRYPTION_KEY.length > 0;
}

function encryptString(plaintext) {
    if (!hasCookieEncryptionKey()) return plaintext;
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(COOKIE_ENCRYPTION_KEY, salt, 32);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return JSON.stringify({
        v: 1,
        alg: 'aes-256-gcm',
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        ciphertext: ciphertext.toString('base64')
    });
}

function decryptString(payload) {
    const parsed = JSON.parse(payload);
    if (!parsed || parsed.alg !== 'aes-256-gcm' || !parsed.salt || !parsed.iv || !parsed.tag || !parsed.ciphertext) {
        throw new Error('Invalid cookie encryption payload');
    }
    if (!hasCookieEncryptionKey()) {
        throw new Error('COOKIE_ENCRYPTION_KEY is required to decrypt cookies');
    }
    const salt = Buffer.from(parsed.salt, 'base64');
    const iv = Buffer.from(parsed.iv, 'base64');
    const tag = Buffer.from(parsed.tag, 'base64');
    const key = crypto.scryptSync(COOKIE_ENCRYPTION_KEY, salt, 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(parsed.ciphertext, 'base64')),
        decipher.final()
    ]);
    return plaintext.toString('utf8');
}

// --------------------------------------------------------------------------
// Browser setup — apply stealth fingerprint to EVERY page (including new tabs)
// --------------------------------------------------------------------------

// This is the single most important fix vs. the previous version. The old
// code applied UA / viewport / timezone / headers ONLY to the first page, then
// listened for `targetcreated` to grab the NYT tab. The NYT tab inherited the
// browser-level defaults from puppeteer, not the patched fingerprint, so NYT
// saw it as a bot.
async function applyStealthToPage(page) {
    try {
        await page.setViewport({
            width: 1440 + Math.floor(Math.random() * 80),
            height: 800 + Math.floor(Math.random() * 80),
            deviceScaleFactor: 1
        });
    } catch (_) { /* viewport may not be settable on all targets */ }

    try {
        // Match what real Chrome on macOS / Linux ships with. puppeteer-real-browser
        // uses the actual Chrome binary, so we let the UA flow through unless an
        // override is provided.
        if (process.env.USER_AGENT_OVERRIDE) {
            await page.setUserAgent(process.env.USER_AGENT_OVERRIDE);
        }
    } catch (_) {}

    try {
        await page.emulateTimezone(TIMEZONE);
    } catch (_) {}

    // The previous script set Accept-Encoding / Connection / Accept manually,
    // which actually weakened the fingerprint because real Chrome doesn't ship
    // those values verbatim and the values can conflict with sec-ch-ua hints.
    // We only set Accept-Language so the page's `navigator.languages` and the
    // header agree, which is what fingerprinters cross-check.
    try {
        await page.setExtraHTTPHeaders({
            'Accept-Language': `${LOCALE},en;q=0.9`
        });
    } catch (_) {}

    // Belt-and-braces JS-level evasions on top of what puppeteer-real-browser
    // already patches. Most are no-ops on real Chrome but harmless.
    try {
        await page.evaluateOnNewDocument(() => {
            // navigator.webdriver
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            // navigator.languages
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            // navigator.plugins — real Chrome ships with at least the PDF viewer.
            try {
                if (!navigator.plugins || navigator.plugins.length === 0) {
                    Object.defineProperty(navigator, 'plugins', {
                        get: () => [1, 2, 3, 4, 5]
                    });
                }
            } catch (_) {}
            // window.chrome
            if (!window.chrome) {
                window.chrome = { runtime: {} };
            }
            // permissions.query notification spoof
            const origQuery = window.navigator.permissions && window.navigator.permissions.query;
            if (origQuery) {
                window.navigator.permissions.query = (parameters) => (
                    parameters && parameters.name === 'notifications'
                        ? Promise.resolve({ state: Notification.permission })
                        : origQuery(parameters)
                );
            }
        });
    } catch (_) {}
}

async function launchBrowser({ headless = false } = {}) {
    await fs.mkdir(USER_DATA_DIR, { recursive: true }).catch(() => null);
    await fs.mkdir(SCREENSHOT_DIR, { recursive: true }).catch(() => null);

    const { browser, page } = await connect({
        headless,
        turnstile: true,
        // puppeteer-real-browser launches a real Chrome (not Chromium) and
        // applies rebrowser-style patches. If a system Chrome path is set, use it.
        customConfig: {
            ...(CHROME_EXECUTABLE_PATH ? { chromePath: CHROME_EXECUTABLE_PATH } : {}),
            userDataDir: USER_DATA_DIR
        },
        connectOption: {
            defaultViewport: null
        },
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            `--lang=${LOCALE}`,
            '--disable-blink-features=AutomationControlled',
            '--start-maximized'
        ],
        disableXvfb: false
    });

    // Apply stealth setup to every page that is ever created in this browser —
    // including the tab that the Fairview site opens when we click the NYT link.
    browser.on('targetcreated', async (target) => {
        try {
            if (target.type() !== 'page') return;
            const newPage = await target.page();
            if (newPage) {
                await applyStealthToPage(newPage);
            }
        } catch (_) { /* nothing actionable */ }
    });

    await applyStealthToPage(page);

    return { browser, page };
}

// --------------------------------------------------------------------------
// Element helpers
// --------------------------------------------------------------------------

async function findFirstSelector(page, selectors, timeoutMs = 4000) {
    for (const selector of selectors) {
        try {
            await page.waitForSelector(selector, { timeout: timeoutMs });
        } catch (error) {
            continue;
        }
        const handle = await page.$(selector);
        if (handle) return handle;
    }
    return null;
}

async function findButtonByText(page, textMatchers) {
    const handle = await page.evaluateHandle((matchers) => {
        const candidates = Array.from(document.querySelectorAll('button, input[type="submit"], a'));
        const lowerMatchers = matchers.map(m => m.toLowerCase());
        return candidates.find(el => {
            const text = (el.textContent || el.value || '').toLowerCase();
            return lowerMatchers.some(matcher => text.includes(matcher));
        }) || null;
    }, textMatchers);

    const element = handle.asElement();
    if (!element) {
        await handle.dispose();
        return null;
    }
    return element;
}

async function safeScreenshot(page, filename) {
    try {
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, filename), fullPage: false });
    } catch (_) { /* screenshot is best-effort */ }
}

// --------------------------------------------------------------------------
// Library login
// --------------------------------------------------------------------------

async function promptForLibraryCredentials() {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise(resolve => rl.question(q, a => resolve(a.trim())));
    const cardNumber = LIBRARY_CARD_NUMBER || await ask('Library card # (BCCLS): ');
    const pin = LIBRARY_PIN || await ask('Library PIN/password: ');
    rl.close();
    return { cardNumber, pin };
}

async function loginToLibrary(page, { cardNumber, pin }) {
    console.log('🔐 Logging in to Fairview/BCCLS...');
    await page.goto(LIBRARY_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await randomDelay(1500, 2800); // simulate landing-page glance

    const cardInput = await findFirstSelector(page, [
        'input[name="barcode"]',
        'input#barcode',
        'input[name="username"]',
        'input#username',
        'input[type="text"]'
    ]);
    const pinInput = await findFirstSelector(page, [
        'input[type="password"]',
        'input[name="password"]',
        'input#password',
        'input[name="pin"]',
        'input#pin'
    ]);

    if (!cardInput || !pinInput) {
        console.error('❌ ERROR: Could not locate library login inputs.');
        await safeScreenshot(page, 'library-login-missing-inputs.png');
        return false;
    }

    if (!await humanClick(page, cardInput)) {
        console.error('❌ ERROR: Library card input not clickable.');
        await safeScreenshot(page, 'library-card-unclickable.png');
        return false;
    }
    await humanType(cardInput, cardNumber);
    await randomDelay(300, 700);

    if (!await humanClick(page, pinInput)) {
        console.error('❌ ERROR: Library PIN input not clickable.');
        await safeScreenshot(page, 'library-pin-unclickable.png');
        return false;
    }
    await humanType(pinInput, pin);
    await randomDelay(400, 900);

    const navPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null);
    await pinInput.press('Enter');
    let navigated = await Promise.race([navPromise, new Promise(r => setTimeout(() => r(null), 1500))]);

    if (!navigated) {
        const loginButton = await findButtonByText(page, ['log in', 'sign in', 'submit']);
        if (!loginButton) {
            console.error('❌ ERROR: Could not find library login button.');
            await safeScreenshot(page, 'library-login-missing-button.png');
            return false;
        }
        const navAfterClick = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null);
        if (!await humanClick(page, loginButton)) {
            console.error('❌ ERROR: Login button not clickable.');
            await safeScreenshot(page, 'library-login-unclickable.png');
            return false;
        }
        navigated = await navAfterClick;
    }

    const pageText = await page.evaluate(() => document.body.innerText.toLowerCase());
    if (pageText.includes('library card') && pageText.includes('password')) {
        console.warn('⚠️  Library login may have failed. Check credentials.');
    }
    return true;
}

// --------------------------------------------------------------------------
// Fairview -> NY Times navigation
// --------------------------------------------------------------------------

async function openNyTimesFromFairview(page, browser) {
    console.log('🌐 Navigating to Fairview Library site...');
    await page.goto(FAIRVIEW_HOME_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    // Spend a believable amount of time on the page before clicking out.
    await randomDelay(2500, 4500);

    // Before clicking, check the NYT link's href and page text for an embedded gift code.
    if (!giftCode) {
        const nytLinkHref = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'));
            const link = links.find(l => {
                const text = (l.textContent || '').toLowerCase();
                return text.includes('ny times') || text.includes('nytimes') || text.includes('new york times');
            });
            if (link) return link.href;
            const img = Array.from(document.querySelectorAll('img')).find(i => {
                const alt = (i.getAttribute('alt') || '').toLowerCase();
                return alt.includes('ny times') || alt.includes('nytimes') || alt.includes('new york times');
            });
            return img?.closest('a')?.href || null;
        });
        if (nytLinkHref) {
            const found = extractCodeFromUrl(nytLinkHref);
            if (found) { giftCode = found; console.log('🎫 Extracted gift code from Fairview link'); }
        }
    }
    if (!giftCode) {
        const pageText = await page.evaluate(() => document.body.innerText);
        const found = extractCodeFromText(pageText);
        if (found) { giftCode = found; console.log('🎫 Extracted gift code from Fairview page text'); }
    }

    const nytimesLink = await page.evaluateHandle(() => {
        const links = Array.from(document.querySelectorAll('a'));
        const linkByText = links.find(link => {
            const text = (link.textContent || '').toLowerCase();
            return text.includes('ny times') || text.includes('nytimes') || text.includes('new york times');
        });
        if (linkByText) return linkByText;
        const image = Array.from(document.querySelectorAll('img')).find(img => {
            const alt = (img.getAttribute('alt') || '').toLowerCase();
            return alt.includes('ny times') || alt.includes('nytimes') || alt.includes('new york times');
        });
        return image ? image.closest('a') : null;
    });

    const linkElement = nytimesLink.asElement();
    if (!linkElement) {
        console.error('❌ ERROR: Could not find NY Times link on Fairview site.');
        await safeScreenshot(page, 'fairview-no-nytimes.png');
        return null;
    }

    // Capture the new tab if the link opens one, OR the same-page navigation
    // if the link is in-tab.
    const newPagePromise = new Promise(resolve => {
        const handler = async (target) => {
            if (target.type() !== 'page') return;
            browser.off('targetcreated', handler);
            const newPage = await target.page();
            // The browser-level targetcreated handler in launchBrowser() will
            // have already applied stealth to it, but we wait for a load event
            // before returning so the caller sees a ready page.
            try {
                await newPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => null);
            } catch (_) {}
            resolve(newPage);
        };
        browser.on('targetcreated', handler);
    });

    const samePageNavPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
        .then(() => page)
        .catch(() => null);

    if (!await humanClick(page, linkElement)) {
        console.error('❌ ERROR: NY Times link not clickable.');
        await safeScreenshot(page, 'fairview-nytimes-unclickable.png');
        return null;
    }

    const nytimesPage = await Promise.race([
        newPagePromise,
        samePageNavPromise,
        new Promise(r => setTimeout(() => r(null), 45000))
    ]);

    if (!nytimesPage) {
        console.error('❌ ERROR: NY Times redemption page did not open.');
        await safeScreenshot(page, 'fairview-nytimes-timeout.png');
        return null;
    }

    // Defensive re-application of stealth in case this page was created
    // before our targetcreated handler ran.
    await applyStealthToPage(nytimesPage);
    await nytimesPage.bringToFront();
    await randomDelay(2000, 4000);

    // Try to extract the gift code from the NYT page URL or visible content.
    if (!giftCode) {
        const nytUrl = nytimesPage.url();
        const found = extractCodeFromUrl(nytUrl);
        if (found) { giftCode = found; console.log('🎫 Extracted gift code from NY Times URL'); }
    }
    if (!giftCode) {
        const nytText = await nytimesPage.evaluate(() => document.body.innerText).catch(() => '');
        const found = extractCodeFromText(nytText);
        if (found) { giftCode = found; console.log('🎫 Extracted gift code from NY Times page'); }
    }

    return nytimesPage;
}

async function ensureGiftCodeFilled(page) {
    if (!giftCode) return;
    const giftInput = await findFirstSelector(page, [
        'input[name="gift_code"]',
        'input#gift_code',
        'input[name="giftCode"]',
        'input[type="text"]'
    ]);
    if (!giftInput) return;
    const currentValue = await page.evaluate(el => el.value, giftInput);
    if (currentValue && currentValue.trim().length > 0) return;
    await humanClick(page, giftInput);
    await humanType(giftInput, giftCode);
}

// --------------------------------------------------------------------------
// History & cookies
// --------------------------------------------------------------------------

async function loadHistory() {
    try {
        const data = await fs.readFile(LOG_PATH, 'utf8');
        return JSON.parse(data);
    } catch (_) {
        return {
            currentCode: giftCode || '',
            codeSetDate: new Date().toISOString(),
            attempts: []
        };
    }
}

async function saveHistory(history) {
    await fs.writeFile(LOG_PATH, JSON.stringify(history, null, 2));
}

async function logAttempt(success, status, codeUsed) {
    const history = await loadHistory();
    if (codeUsed !== history.currentCode) {
        console.log(`📝 New code detected: ${codeUsed.substring(0, 8)}...`);
        if (history.codeSetDate && history.attempts.length > 0) {
            const days = Math.floor((new Date() - new Date(history.codeSetDate)) / (1000 * 60 * 60 * 24));
            console.log(`ℹ️  Previous code lasted: ${days} days`);
        }
        history.currentCode = codeUsed;
        history.codeSetDate = new Date().toISOString();
    }
    history.attempts.push({
        timestamp: new Date().toISOString(),
        success,
        status,
        codeUsed
    });
    if (history.attempts.length > 30) history.attempts = history.attempts.slice(-30);
    await saveHistory(history);
    await analyzePattern(history);
}

async function analyzePattern(history) {
    const recent = history.attempts.slice(-10);
    const ok = recent.filter(a => a.success).length;
    const fail = recent.filter(a => !a.success).length;
    console.log(`\n📊 Recent History (last ${recent.length} attempts):`);
    console.log(`   ✓ Successful: ${ok}`);
    console.log(`   ✗ Failed: ${fail}`);
    if (history.attempts.length >= 5) {
        const age = Math.floor((new Date() - new Date(history.codeSetDate)) / (1000 * 60 * 60 * 24));
        console.log(`   📅 Current code age: ${age} days`);
        if (fail >= 2) console.log(`   ⚠️  WARNING: Multiple failures. Code may need updating!`);
    }
    console.log('');
}

async function loadCookies(page) {
    try {
        const cookiesString = await fs.readFile(COOKIES_PATH, 'utf8');
        let cookieJson = cookiesString;
        if (cookiesString.trim().startsWith('{')) {
            try {
                const parsed = JSON.parse(cookiesString);
                if (parsed && parsed.alg === 'aes-256-gcm') {
                    cookieJson = decryptString(cookiesString);
                }
            } catch (error) {
                if (hasCookieEncryptionKey()) throw error;
            }
        }
        const cookies = JSON.parse(cookieJson);
        await page.setCookie(...cookies);
        console.log(`Loaded existing cookies${hasCookieEncryptionKey() ? ' (encrypted)' : ''}`);
        return true;
    } catch (error) {
        if (error.message && error.message.includes('COOKIE_ENCRYPTION_KEY')) {
            console.error(`❌ ERROR: ${error.message}`);
        } else {
            console.log('No existing cookies found');
        }
        return false;
    }
}

async function saveCookies(page) {
    const cookies = await page.cookies();
    const json = JSON.stringify(cookies, null, 2);
    const payload = encryptString(json);
    await fs.writeFile(COOKIES_PATH, payload);
    console.log(`Saved cookies${hasCookieEncryptionKey() ? ' (encrypted)' : ''}`);
}

// --------------------------------------------------------------------------
// Main redemption flow
// --------------------------------------------------------------------------

async function redeemSubscription() {
    const timestamp = new Date().toISOString();
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🕐 Starting redemption: ${timestamp}`);
    console.log(giftCode ? `🎫 Using code: ${giftCode.substring(0, 8)}...` : '🎫 Gift code not yet known — will fetch from Fairview');
    console.log(`${'='.repeat(60)}\n`);

    let browser;
    try {
        const launched = await launchBrowser({ headless: false });
        browser = launched.browser;
        const page = launched.page;

        await loadCookies(page);

        const credentials = SHOULD_PROMPT_LIBRARY_CREDENTIALS
            ? await promptForLibraryCredentials()
            : { cardNumber: LIBRARY_CARD_NUMBER, pin: LIBRARY_PIN };

        if (credentials.cardNumber && credentials.pin) {
            await loginToLibrary(page, credentials);
        } else {
            console.log('ℹ️  No library credentials provided. Attempting without login.');
        }

        console.log('🌐 Opening NY Times redemption from Fairview site...');
        await randomDelay(800, 2000);

        const nytimesPage = await openNyTimesFromFairview(page, browser);
        if (!nytimesPage) {
            await logAttempt(false, 'NYTIMES_LINK_FAILED', giftCode);
            return false;
        }

        if (!giftCode) {
            console.error('❌ ERROR: Could not find gift code on Fairview site or NY Times page.');
            console.error('   Set NYTIMES_GIFT_CODE in .env as a fallback, or check that the Fairview NYT page is accessible.');
            await safeScreenshot(nytimesPage, 'no-gift-code.png');
            await logAttempt(false, 'NO_GIFT_CODE', null);
            return false;
        }
        console.log(`🎫 Gift code: ${giftCode.substring(0, 8)}...`);

        await ensureGiftCodeFilled(nytimesPage);

        console.log('📖 Simulating human reading time...');
        await randomDelay(3500, 6000);

        // Random small mouse jitter to look engaged before any click.
        await page.mouse.move(randomBetween(200, 1000), randomBetween(150, 600)).catch(() => null);

        const pageContent = await nytimesPage.evaluate(() => document.body.innerText.toLowerCase());

        if (pageContent.includes('access denied') || pageContent.includes('blocked') || pageContent.includes('robot')) {
            console.error('❌ ERROR: Detected by anti-bot protection!');
            console.error('🤖 NY Times thinks we are a bot.');
            console.error('   Try running `node redeem.js --manual-login` once to seed cookies and warm the profile.');
            await safeScreenshot(nytimesPage, 'bot-detected.png');
            await logAttempt(false, 'BOT_DETECTED', giftCode);
            return false;
        }

        if (pageContent.includes('log in') || pageContent.includes('sign in')) {
            console.error('❌ ERROR: Not authenticated.');
            console.error('   Run `node redeem.js --manual-login` to seed cookies, or provide library credentials.');
            await safeScreenshot(nytimesPage, 'login-required.png');
            await logAttempt(false, 'AUTH_REQUIRED', giftCode);
            return false;
        }

        if (
            pageContent.includes('invalid code') ||
            pageContent.includes('expired') ||
            pageContent.includes('code has been used') ||
            pageContent.includes('no longer valid')
        ) {
            console.error('❌ ERROR: Code appears to be invalid or expired!');
            console.error('🔄 Please update NYTIMES_GIFT_CODE in .env file');
            await safeScreenshot(nytimesPage, 'expired-code.png');
            await logAttempt(false, 'CODE_EXPIRED', giftCode);
            return false;
        }

        if (pageContent.includes('already redeemed') || pageContent.includes('already claimed')) {
            console.log('ℹ️  Token already redeemed today');
            await safeScreenshot(nytimesPage, 'already-redeemed.png');
            await saveCookies(nytimesPage);
            await logAttempt(true, 'ALREADY_REDEEMED', giftCode);
            return true;
        }

        console.log('🔍 Looking for redeem button...');
        const redeemHandle = await nytimesPage.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button, a, input[type="submit"]'));
            return buttons.find(b => {
                const text = (b.textContent || b.value || '').toLowerCase();
                return text.includes('redeem') || text.includes('claim') || text.includes('activate');
            }) || null;
        });

        const redeemElement = redeemHandle.asElement();
        if (!redeemElement) {
            console.error('❌ ERROR: Could not find redeem button');
            await safeScreenshot(nytimesPage, 'no-button.png');
            console.log('Page content preview:', pageContent.substring(0, 500));
            await logAttempt(false, 'NO_BUTTON', giftCode);
            return false;
        }

        console.log('🖱️  Moving mouse to button...');
        await randomDelay(700, 1300);

        console.log('✋ Clicking redeem button...');
        if (!await humanClick(nytimesPage, redeemElement)) {
            console.error('❌ ERROR: Redeem button not clickable');
            await safeScreenshot(nytimesPage, 'redeem-unclickable.png');
            await logAttempt(false, 'REDEEM_UNCLICKABLE', giftCode);
            return false;
        }

        await randomDelay(4500, 7000);

        const resultContent = await nytimesPage.evaluate(() => document.body.innerText.toLowerCase());

        if (resultContent.includes('access denied') || resultContent.includes('blocked') || resultContent.includes('robot')) {
            console.error('❌ ERROR: Bot detected after clicking button');
            await safeScreenshot(nytimesPage, 'bot-detected-after-click.png');
            await logAttempt(false, 'BOT_DETECTED_AFTER_CLICK', giftCode);
            return false;
        }

        if (resultContent.includes('invalid') || resultContent.includes('expired')) {
            console.error('❌ Code rejected after click - likely expired!');
            await safeScreenshot(nytimesPage, 'expired-code.png');
            await logAttempt(false, 'CODE_EXPIRED_AFTER_CLICK', giftCode);
            return false;
        }

        const isSuccess =
            resultContent.includes('success') ||
            resultContent.includes('redeemed') ||
            resultContent.includes('activated') ||
            resultContent.includes('thank you') ||
            resultContent.includes('welcome');

        if (isSuccess) {
            console.log('✅ Redemption successful!');
            await safeScreenshot(nytimesPage, 'success.png');
            await saveCookies(nytimesPage);
            await logAttempt(true, 'SUCCESS', giftCode);
            return true;
        }

        console.log('⚠️  Unclear result - check screenshot');
        await safeScreenshot(nytimesPage, 'unclear.png');
        await logAttempt(false, 'UNCLEAR', giftCode);
        return false;
    } catch (error) {
        console.error('💥 Error during redemption:', error.message);
        await logAttempt(false, 'ERROR', giftCode);
        return false;
    } finally {
        if (browser) {
            try { await browser.close(); } catch (_) {}
        }
        console.log(`\n${'='.repeat(60)}\n`);
    }
}

// --------------------------------------------------------------------------
// Manual login helper — opens a headful real Chrome so the user can log in once.
// Also seeds the persistent profile / cookies for future automated runs.
// --------------------------------------------------------------------------

async function manualLogin() {
    console.log('\n=== Manual Login Mode ===');
    console.log('A real Chrome window will open to the Fairview/BCCLS login page.');
    console.log('Log in, then go to the Fairview site and click the NY Times icon.');
    console.log('Once the NY Times redemption page is open, press Ctrl+C to save cookies.\n');

    const { browser, page } = await connect({
        headless: false,
        turnstile: true,
        customConfig: {
            ...(CHROME_EXECUTABLE_PATH ? { chromePath: CHROME_EXECUTABLE_PATH } : {}),
            userDataDir: USER_DATA_DIR
        },
        connectOption: { defaultViewport: null },
        args: ['--no-sandbox', '--disable-setuid-sandbox', `--lang=${LOCALE}`, '--start-maximized'],
        disableXvfb: false
    });

    let activePage = page;
    browser.on('targetcreated', async (target) => {
        try {
            if (target.type() !== 'page') return;
            const newPage = await target.page();
            if (newPage) {
                await applyStealthToPage(newPage);
                activePage = newPage;
            }
        } catch (_) {}
    });

    await applyStealthToPage(page);
    await page.goto(LIBRARY_LOGIN_URL);

    await new Promise(() => {
        process.on('SIGINT', async () => {
            console.log('\nSaving cookies...');
            try { await saveCookies(activePage); } catch (e) { console.error(e); }
            try { await browser.close(); } catch (_) {}
            console.log('Cookies saved! You can now run the automated script.');
            process.exit(0);
        });
    });
}

// --------------------------------------------------------------------------
// History viewer (unchanged)
// --------------------------------------------------------------------------

async function showHistory() {
    const history = await loadHistory();
    console.log('\n📊 Redemption History Report');
    console.log('='.repeat(60));
    console.log(`Current Code: ${history.currentCode.substring(0, 8)}...`);
    console.log(`Code Set Date: ${new Date(history.codeSetDate).toLocaleString()}`);
    const age = Math.floor((new Date() - new Date(history.codeSetDate)) / (1000 * 60 * 60 * 24));
    console.log(`Code Age: ${age} days`);
    console.log(`\nTotal Attempts: ${history.attempts.length}`);
    if (history.attempts.length > 0) {
        console.log('\nRecent Attempts:');
        history.attempts.slice(-10).reverse().forEach((a) => {
            const icon = a.success ? '✅' : '❌';
            const date = new Date(a.timestamp).toLocaleString();
            console.log(`  ${icon} ${date} - ${a.status}`);
        });
        const ok = history.attempts.filter(a => a.success).length;
        const rate = ((ok / history.attempts.length) * 100).toFixed(1);
        console.log(`\nSuccess Rate: ${rate}% (${ok}/${history.attempts.length})`);
    }
    console.log('='.repeat(60) + '\n');
}

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------

if (process.argv.includes('--manual-login')) {
    manualLogin();
} else if (process.argv.includes('--history')) {
    showHistory();
} else {
    redeemSubscription()
        .then(success => process.exit(success ? 0 : 1))
        .catch(error => {
            console.error('Fatal error:', error);
            process.exit(1);
        });
}
