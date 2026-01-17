const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const COOKIES_PATH = path.join(__dirname, 'cookies', 'nytimes-cookies.json');
const LOG_PATH = path.join(__dirname, 'cookies', 'redemption-history.json');
const GIFT_CODE = process.env.NYTIMES_GIFT_CODE;
const COOKIE_ENCRYPTION_KEY = process.env.COOKIE_ENCRYPTION_KEY;
const LIBRARY_CARD_NUMBER = process.env.LIBRARY_CARD_NUMBER;
const LIBRARY_PIN = process.env.LIBRARY_PIN;
const LIBRARY_LOGIN_URL = process.env.LIBRARY_LOGIN_URL ||
    'https://catalog.bccls.org/polaris/logon.aspx?ctx=37.1033.0.0.6';
const FAIRVIEW_HOME_URL = process.env.FAIRVIEW_HOME_URL || 'https://fairviewlibrarynj.org/en/';

if (!GIFT_CODE) {
    console.error('ERROR: NYTIMES_GIFT_CODE must be set in .env');
    process.exit(1);
}

// Random delay to simulate human behavior
function randomDelay(min = 1000, max = 3000) {
    return new Promise(resolve => setTimeout(resolve, Math.random() * (max - min) + min));
}

const CLI_ARGS = new Set(process.argv.slice(2));
const SHOULD_PROMPT_LIBRARY_CREDENTIALS = CLI_ARGS.has('--prompt-library-credentials');

function hasCookieEncryptionKey() {
    return typeof COOKIE_ENCRYPTION_KEY === 'string' && COOKIE_ENCRYPTION_KEY.length > 0;
}

function encryptString(plaintext) {
    if (!hasCookieEncryptionKey()) {
        return plaintext;
    }

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

async function promptForLibraryCredentials() {
    const readline = require('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const ask = (question) => new Promise(resolve => {
        rl.question(question, answer => resolve(answer.trim()));
    });

    const cardNumber = LIBRARY_CARD_NUMBER || await ask('Library card # (BCCLS): ');
    const pin = LIBRARY_PIN || await ask('Library PIN/password: ');

    rl.close();

    return {
        cardNumber,
        pin
    };
}

async function findFirstSelector(page, selectors) {
    for (const selector of selectors) {
        const handle = await page.$(selector);
        if (handle) {
            return handle;
        }
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

    const element = await handle.asElement();
    if (!element) {
        await handle.dispose();
        return null;
    }
    return element;
}

async function loginToLibrary(page, { cardNumber, pin }) {
    console.log('🔐 Logging in to Fairview/BCCLS...');
    await page.goto(LIBRARY_LOGIN_URL, {
        waitUntil: 'networkidle2',
        timeout: 60000
    });

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
        await page.screenshot({ path: '/app/cookies/library-login-missing-inputs.png' });
        return false;
    }

    await cardInput.click({ clickCount: 3 });
    await cardInput.type(cardNumber, { delay: 50 });
    await randomDelay(200, 400);
    await pinInput.click({ clickCount: 3 });
    await pinInput.type(pin, { delay: 50 });

    const loginButton = await findButtonByText(page, ['log in', 'sign in', 'submit']);
    if (!loginButton) {
        console.error('❌ ERROR: Could not find library login button.');
        await page.screenshot({ path: '/app/cookies/library-login-missing-button.png' });
        return false;
    }

    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null),
        loginButton.click()
    ]);

    const pageText = await page.evaluate(() => document.body.innerText.toLowerCase());
    if (pageText.includes('library card') && pageText.includes('password')) {
        console.warn('⚠️  Library login may have failed. Check credentials.');
    }

    return true;
}

async function openNyTimesFromFairview(page, browser) {
    console.log('🌐 Navigating to Fairview Library site...');
    await page.goto(FAIRVIEW_HOME_URL, {
        waitUntil: 'networkidle2',
        timeout: 60000
    });

    const nytimesLink = await page.evaluateHandle(() => {
        const links = Array.from(document.querySelectorAll('a'));
        const linkByText = links.find(link => {
            const text = (link.textContent || '').toLowerCase();
            return text.includes('ny times') || text.includes('nytimes');
        });

        if (linkByText) {
            return linkByText;
        }

        const image = Array.from(document.querySelectorAll('img')).find(img => {
            const alt = (img.getAttribute('alt') || '').toLowerCase();
            return alt.includes('ny times') || alt.includes('nytimes');
        });

        return image ? image.closest('a') : null;
    });

    const linkElement = await nytimesLink.asElement();
    if (!linkElement) {
        console.error('❌ ERROR: Could not find NY Times link on Fairview site.');
        await page.screenshot({ path: '/app/cookies/fairview-no-nytimes.png' });
        return null;
    }

    const newPagePromise = new Promise(resolve => {
        const handler = async (target) => {
            if (target.type() !== 'page') {
                return;
            }
            browser.off('targetcreated', handler);
            resolve(await target.page());
        };
        browser.on('targetcreated', handler);
    });

    const navigationPromise = page.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: 30000
    }).then(() => page).catch(() => null);

    await linkElement.click();

    const nytimesPage = await Promise.race([newPagePromise, navigationPromise]);
    if (!nytimesPage) {
        console.error('❌ ERROR: NY Times redemption page did not open.');
        await page.screenshot({ path: '/app/cookies/fairview-nytimes-timeout.png' });
        return null;
    }

    await nytimesPage.bringToFront();
    return nytimesPage;
}

async function ensureGiftCodeFilled(page) {
    if (!GIFT_CODE) {
        return;
    }

    const giftInput = await findFirstSelector(page, [
        'input[name="gift_code"]',
        'input#gift_code',
        'input[name="giftCode"]',
        'input[type="text"]'
    ]);

    if (!giftInput) {
        return;
    }

    const currentValue = await page.evaluate(el => el.value, giftInput);
    if (currentValue && currentValue.trim().length > 0) {
        return;
    }

    await giftInput.click({ clickCount: 3 });
    await giftInput.type(GIFT_CODE, { delay: 40 });
}

// Redemption history tracking
async function loadHistory() {
    try {
        const historyData = await fs.readFile(LOG_PATH, 'utf8');
        return JSON.parse(historyData);
    } catch (error) {
        return {
            currentCode: GIFT_CODE,
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
    
    // Detect if code changed
    if (codeUsed !== history.currentCode) {
        console.log(`📝 New code detected: ${codeUsed.substring(0, 8)}...`);
        
        // Calculate how long the previous code lasted
        if (history.codeSetDate && history.attempts.length > 0) {
            const codeLifespan = Math.floor(
                (new Date() - new Date(history.codeSetDate)) / (1000 * 60 * 60 * 24)
            );
            console.log(`ℹ️  Previous code lasted: ${codeLifespan} days`);
        }
        
        history.currentCode = codeUsed;
        history.codeSetDate = new Date().toISOString();
    }
    
    history.attempts.push({
        timestamp: new Date().toISOString(),
        success: success,
        status: status,
        codeUsed: codeUsed
    });
    
    // Keep only last 30 attempts
    if (history.attempts.length > 30) {
        history.attempts = history.attempts.slice(-30);
    }
    
    await saveHistory(history);
    await analyzePattern(history);
}

async function analyzePattern(history) {
    const recentAttempts = history.attempts.slice(-10);
    const successCount = recentAttempts.filter(a => a.success).length;
    const failCount = recentAttempts.filter(a => !a.success).length;
    
    console.log(`\n📊 Recent History (last ${recentAttempts.length} attempts):`);
    console.log(`   ✓ Successful: ${successCount}`);
    console.log(`   ✗ Failed: ${failCount}`);
    
    if (history.attempts.length >= 5) {
        const codeAge = Math.floor(
            (new Date() - new Date(history.codeSetDate)) / (1000 * 60 * 60 * 24)
        );
        console.log(`   📅 Current code age: ${codeAge} days`);
        
        if (failCount >= 2) {
            console.log(`   ⚠️  WARNING: Multiple failures detected. Code may need updating!`);
        }
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
                if (hasCookieEncryptionKey()) {
                    throw error;
                }
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
    const cookieJson = JSON.stringify(cookies, null, 2);
    const payload = encryptString(cookieJson);
    await fs.writeFile(COOKIES_PATH, payload);
    console.log(`Saved cookies${hasCookieEncryptionKey() ? ' (encrypted)' : ''}`);
}

async function redeemSubscription() {
    const timestamp = new Date().toISOString();
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🕐 Starting redemption: ${timestamp}`);
    console.log(`🎫 Using code: ${GIFT_CODE.substring(0, 8)}...`);
    console.log(`${'='.repeat(60)}\n`);
    
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1920,1080',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            ],
            ignoreHTTPSErrors: true
        });

        const page = await browser.newPage();
        
        // Set realistic viewport
        await page.setViewport({ 
            width: 1920, 
            height: 1080,
            deviceScaleFactor: 1
        });
        
        // Set realistic user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Add extra headers to look more human
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        });
        
        // Load cookies
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

        // Add random delay before navigation (human-like)
        await randomDelay(500, 1500);

        const nytimesPage = await openNyTimesFromFairview(page, browser);
        if (!nytimesPage) {
            await logAttempt(false, 'NYTIMES_LINK_FAILED', GIFT_CODE);
            return false;
        }

        // Ensure gift code is filled if the page expects input
        await ensureGiftCodeFilled(nytimesPage);
        
        // Random delay after page load (simulate reading)
        console.log('📖 Simulating human reading time...');
        await randomDelay(3000, 5000);
        
        const pageContent = await nytimesPage.evaluate(() => document.body.innerText.toLowerCase());
        
        // Check for bot detection
        if (pageContent.includes('blocked') || pageContent.includes('robot')) {
            console.error('❌ ERROR: Detected by anti-bot protection!');
            console.error('🤖 NYTimes thinks we are a bot. Try manual login first.');
            await nytimesPage.screenshot({ path: '/app/cookies/bot-detected.png' });
            await logAttempt(false, 'BOT_DETECTED', GIFT_CODE);
            return false;
        }
        
        // Check authentication
        if (pageContent.includes('log in') || pageContent.includes('sign in')) {
            console.error('❌ ERROR: Not authenticated');
            console.error('Run: docker-compose exec nytimes-redeem node redeem.js --manual-login');
            console.error('Or provide library credentials with --prompt-library-credentials.');
            await nytimesPage.screenshot({ path: '/app/cookies/login-required.png' });
            await logAttempt(false, 'AUTH_REQUIRED', GIFT_CODE);
            return false;
        }
        
        // Check if code is invalid/expired
        if (pageContent.includes('invalid code') || 
            pageContent.includes('expired') ||
            pageContent.includes('code has been used') ||
            pageContent.includes('no longer valid')) {
            console.error('❌ ERROR: Code appears to be invalid or expired!');
            console.error('🔄 Please update NYTIMES_GIFT_CODE in .env file');
            await nytimesPage.screenshot({ path: '/app/cookies/expired-code.png' });
            await logAttempt(false, 'CODE_EXPIRED', GIFT_CODE);
            return false;
        }
        
        // Check if already redeemed
        if (pageContent.includes('already redeemed') || 
            pageContent.includes('already claimed')) {
            console.log('ℹ️  Token already redeemed today');
            await nytimesPage.screenshot({ path: '/app/cookies/already-redeemed.png' });
            await saveCookies(nytimesPage);
            await logAttempt(true, 'ALREADY_REDEEMED', GIFT_CODE);
            return true;
        }
        
        // Look for redeem button
        console.log('🔍 Looking for redeem button...');
        let redeemButton = await nytimesPage.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button, a, input[type="submit"]'));
            return buttons.find(button => {
                const text = button.textContent || button.value || '';
                return text.toLowerCase().includes('redeem') ||
                       text.toLowerCase().includes('claim') ||
                       text.toLowerCase().includes('activate');
            });
        });
        
        if (!redeemButton || !(await redeemButton.asElement())) {
            console.error('❌ ERROR: Could not find redeem button');
            await nytimesPage.screenshot({ path: '/app/cookies/no-button.png' });
            console.log('Page content preview:', pageContent.substring(0, 500));
            await logAttempt(false, 'NO_BUTTON', GIFT_CODE);
            return false;
        }
        
        // Simulate mouse movement before click (more human-like)
        console.log('🖱️  Moving mouse to button...');
        await randomDelay(500, 1000);
        
        console.log('✋ Clicking redeem button...');
        await redeemButton.click();
        
        // Random delay after click
        await randomDelay(4000, 6000);
        
        const resultContent = await nytimesPage.evaluate(() => document.body.innerText.toLowerCase());
        
        // Check for bot detection after click
        if (resultContent.includes('blocked') || resultContent.includes('robot')) {
            console.error('❌ ERROR: Bot detected after clicking button');
            await nytimesPage.screenshot({ path: '/app/cookies/bot-detected-after-click.png' });
            await logAttempt(false, 'BOT_DETECTED_AFTER_CLICK', GIFT_CODE);
            return false;
        }
        
        // Check result
        if (resultContent.includes('invalid') || resultContent.includes('expired')) {
            console.error('❌ Code rejected after click - likely expired!');
            await nytimesPage.screenshot({ path: '/app/cookies/expired-code.png' });
            await logAttempt(false, 'CODE_EXPIRED_AFTER_CLICK', GIFT_CODE);
            return false;
        }
        
        const isSuccess = resultContent.includes('success') || 
                         resultContent.includes('redeemed') ||
                         resultContent.includes('activated') ||
                         resultContent.includes('thank you');
        
        if (isSuccess) {
            console.log('✅ Redemption successful!');
            await nytimesPage.screenshot({ path: '/app/cookies/success.png' });
            await saveCookies(nytimesPage);
            await logAttempt(true, 'SUCCESS', GIFT_CODE);
            return true;
        } else {
            console.log('⚠️  Unclear result - check screenshot');
            await nytimesPage.screenshot({ path: '/app/cookies/unclear.png' });
            await logAttempt(false, 'UNCLEAR', GIFT_CODE);
            return false;
        }
        
    } catch (error) {
        console.error('💥 Error during redemption:', error.message);
        await logAttempt(false, 'ERROR', GIFT_CODE);
        return false;
    } finally {
        if (browser) {
            await browser.close();
        }
        console.log(`\n${'='.repeat(60)}\n`);
    }
}

// Manual login helper
async function manualLogin() {
    console.log('\n=== Manual Login Mode ===');
    console.log('A browser window will open to the Fairview/BCCLS login page.');
    console.log('Log in, then visit the Fairview site and click the NY Times icon.');
    console.log('Once the NY Times redemption page is open, press Ctrl+C to save cookies.\n');
    
    const browser = await puppeteer.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    let activePage = page;

    browser.on('targetcreated', async target => {
        if (target.type() === 'page') {
            activePage = await target.page();
        }
    });

    await page.goto(LIBRARY_LOGIN_URL);
    
    // Wait for user to log in (keep browser open)
    await new Promise(resolve => {
        process.on('SIGINT', async () => {
            console.log('\nSaving cookies...');
            await saveCookies(activePage);
            await browser.close();
            console.log('Cookies saved! You can now run the automated script.');
            process.exit(0);
        });
    });
}

// Show redemption history
async function showHistory() {
    const history = await loadHistory();
    
    console.log('\n📊 Redemption History Report');
    console.log('='.repeat(60));
    console.log(`Current Code: ${history.currentCode.substring(0, 8)}...`);
    console.log(`Code Set Date: ${new Date(history.codeSetDate).toLocaleString()}`);
    
    const codeAge = Math.floor(
        (new Date() - new Date(history.codeSetDate)) / (1000 * 60 * 60 * 24)
    );
    console.log(`Code Age: ${codeAge} days`);
    
    console.log(`\nTotal Attempts: ${history.attempts.length}`);
    
    if (history.attempts.length > 0) {
        console.log('\nRecent Attempts:');
        history.attempts.slice(-10).reverse().forEach((attempt, i) => {
            const icon = attempt.success ? '✅' : '❌';
            const date = new Date(attempt.timestamp).toLocaleString();
            console.log(`  ${icon} ${date} - ${attempt.status}`);
        });
        
        // Calculate success rate
        const successCount = history.attempts.filter(a => a.success).length;
        const successRate = ((successCount / history.attempts.length) * 100).toFixed(1);
        console.log(`\nSuccess Rate: ${successRate}% (${successCount}/${history.attempts.length})`);
    }
    
    console.log('='.repeat(60) + '\n');
}

// Main execution
if (process.argv.includes('--manual-login')) {
    manualLogin();
} else if (process.argv.includes('--history')) {
    showHistory();
} else {
    redeemSubscription()
        .then(success => {
            process.exit(success ? 0 : 1);
        })
        .catch(error => {
            console.error('Fatal error:', error);
            process.exit(1);
        });
}
