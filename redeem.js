const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const COOKIES_PATH = path.join(__dirname, 'cookies', 'nytimes-cookies.json');
const LOG_PATH = path.join(__dirname, 'cookies', 'redemption-history.json');
const CAMPAIGN_ID = process.env.NYTIMES_CAMPAIGN_ID;
const GIFT_CODE = process.env.NYTIMES_GIFT_CODE;
const COOKIE_ENCRYPTION_KEY = process.env.COOKIE_ENCRYPTION_KEY;

if (!CAMPAIGN_ID || !GIFT_CODE) {
    console.error('ERROR: NYTIMES_CAMPAIGN_ID and NYTIMES_GIFT_CODE must be set in .env');
    process.exit(1);
}

const REDEEM_URL = `https://www.nytimes.com/subscription/redeem?campaignId=${CAMPAIGN_ID}&gift_code=${GIFT_CODE}`;

// Random delay to simulate human behavior
function randomDelay(min = 1000, max = 3000) {
    return new Promise(resolve => setTimeout(resolve, Math.random() * (max - min) + min));
}

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
        
        console.log('🌐 Navigating to redemption page...');
        
        // Add random delay before navigation (human-like)
        await randomDelay(500, 1500);
        
        await page.goto(REDEEM_URL, { 
            waitUntil: 'networkidle2',
            timeout: 60000 
        });
        
        // Random delay after page load (simulate reading)
        console.log('📖 Simulating human reading time...');
        await randomDelay(3000, 5000);
        
        const pageContent = await page.evaluate(() => document.body.innerText.toLowerCase());
        
        // Check for bot detection
        if (pageContent.includes('blocked') || pageContent.includes('robot')) {
            console.error('❌ ERROR: Detected by anti-bot protection!');
            console.error('🤖 NYTimes thinks we are a bot. Try manual login first.');
            await page.screenshot({ path: '/app/cookies/bot-detected.png' });
            await logAttempt(false, 'BOT_DETECTED', GIFT_CODE);
            return false;
        }
        
        // Check authentication
        if (pageContent.includes('log in') || pageContent.includes('sign in')) {
            console.error('❌ ERROR: Not authenticated');
            console.error('Run: docker-compose exec nytimes-redeem node redeem.js --manual-login');
            await page.screenshot({ path: '/app/cookies/login-required.png' });
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
            await page.screenshot({ path: '/app/cookies/expired-code.png' });
            await logAttempt(false, 'CODE_EXPIRED', GIFT_CODE);
            return false;
        }
        
        // Check if already redeemed
        if (pageContent.includes('already redeemed') || 
            pageContent.includes('already claimed')) {
            console.log('ℹ️  Token already redeemed today');
            await page.screenshot({ path: '/app/cookies/already-redeemed.png' });
            await saveCookies(page);
            await logAttempt(true, 'ALREADY_REDEEMED', GIFT_CODE);
            return true;
        }
        
        // Look for redeem button
        console.log('🔍 Looking for redeem button...');
        let redeemButton = await page.evaluateHandle(() => {
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
            await page.screenshot({ path: '/app/cookies/no-button.png' });
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
        
        const resultContent = await page.evaluate(() => document.body.innerText.toLowerCase());
        
        // Check for bot detection after click
        if (resultContent.includes('blocked') || resultContent.includes('robot')) {
            console.error('❌ ERROR: Bot detected after clicking button');
            await page.screenshot({ path: '/app/cookies/bot-detected-after-click.png' });
            await logAttempt(false, 'BOT_DETECTED_AFTER_CLICK', GIFT_CODE);
            return false;
        }
        
        // Check result
        if (resultContent.includes('invalid') || resultContent.includes('expired')) {
            console.error('❌ Code rejected after click - likely expired!');
            await page.screenshot({ path: '/app/cookies/expired-code.png' });
            await logAttempt(false, 'CODE_EXPIRED_AFTER_CLICK', GIFT_CODE);
            return false;
        }
        
        const isSuccess = resultContent.includes('success') || 
                         resultContent.includes('redeemed') ||
                         resultContent.includes('activated') ||
                         resultContent.includes('thank you');
        
        if (isSuccess) {
            console.log('✅ Redemption successful!');
            await page.screenshot({ path: '/app/cookies/success.png' });
            await saveCookies(page);
            await logAttempt(true, 'SUCCESS', GIFT_CODE);
            return true;
        } else {
            console.log('⚠️  Unclear result - check screenshot');
            await page.screenshot({ path: '/app/cookies/unclear.png' });
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
    console.log('A browser window will open. Please log in to NYTimes.');
    console.log('After logging in, press Ctrl+C to save cookies and exit.\n');
    
    const browser = await puppeteer.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.goto('https://www.nytimes.com/');
    
    // Wait for user to log in (keep browser open)
    await new Promise(resolve => {
        process.on('SIGINT', async () => {
            console.log('\nSaving cookies...');
            await saveCookies(page);
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
