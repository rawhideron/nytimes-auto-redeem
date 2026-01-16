// Use puppeteer-extra with stealth plugin to avoid bot detection
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs').promises;
const path = require('path');

const COOKIES_PATH = path.join(__dirname, 'cookies', 'nytimes-cookies.json');
const LOG_PATH = path.join(__dirname, 'cookies', 'redemption-history.json');
const CAMPAIGN_ID = process.env.NYTIMES_CAMPAIGN_ID;
const GIFT_CODE = process.env.NYTIMES_GIFT_CODE;

if (!CAMPAIGN_ID || !GIFT_CODE) {
    console.error('ERROR: NYTIMES_CAMPAIGN_ID and NYTIMES_GIFT_CODE must be set in .env');
    process.exit(1);
}

const REDEEM_URL = `https://www.nytimes.com/subscription/redeem?campaignId=${CAMPAIGN_ID}&gift_code=${GIFT_CODE}`;

// Add random delays to appear more human
function randomDelay(min = 1000, max = 3000) {
    return new Promise(resolve => setTimeout(resolve, Math.random() * (max - min) + min));
}

// ... keep all your existing helper functions (loadHistory, saveHistory, etc.) ...

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
                '--disable-blink-features=AutomationControlled',  // Hide automation
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
            console.error('🤖 NYTimes thinks we are a bot. Check screenshot.');
            await page.screenshot({ path: '/app/cookies/bot-detected.png' });
            await logAttempt(false, 'BOT_DETECTED', GIFT_CODE);
            return false;
        }
        
        // Check authentication
        if (pageContent.includes('log in') || pageContent.includes('sign in')) {
            console.error('❌ ERROR: Not authenticated');
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

// Keep your existing manualLogin function and main execution code unchanged
