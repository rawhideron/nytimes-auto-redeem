const COOKIES_PATH = path.join(__dirname, 'cookies', 'nytimes-cookies.json');
const REDEEM_URL = 'https://www.nytimes.com/subscription/redeem?campaignId=6Y9QR&gift_code=24170f51d678a288';

const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

const COOKIES_PATH = path.join(__dirname, 'cookies', 'nytimes-cookies.json');
const REDEEM_URL = process.env.NYTIMES_REDEEM_URL || 'https://www.nytimes.com/subscription/redeem';

if (!process.env.NYTIMES_REDEEM_URL) {
    console.error('ERROR: NYTIMES_REDEEM_URL environment variable not set');
    process.exit(1);
}


async function loadCookies(page) {
    try {
        const cookiesString = await fs.readFile(COOKIES_PATH, 'utf8');
        const cookies = JSON.parse(cookiesString);
        await page.setCookie(...cookies);
        console.log('Loaded existing cookies');
        return true;
    } catch (error) {
        console.log('No existing cookies found');
        return false;
    }
}

async function saveCookies(page) {
    const cookies = await page.cookies();
    await fs.writeFile(COOKIES_PATH, JSON.stringify(cookies, null, 2));
    console.log('Saved cookies');
}

async function redeemSubscription() {
    const timestamp = new Date().toISOString();
    console.log(`\n=== Starting redemption process at ${timestamp} ===`);
    
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });

        const page = await browser.newPage();
        
        // Set viewport
        await page.setViewport({ width: 1280, height: 800 });
        
        // Load existing cookies if available
        await loadCookies(page);
        
        // Navigate to the redemption page
        console.log('Navigating to redemption page...');
        await page.goto(REDEEM_URL, { 
            waitUntil: 'networkidle2',
            timeout: 60000 
        });
        
        // Wait a bit for the page to fully load
        await page.waitForTimeout(3000);
        
        // Get page content for analysis
        const pageContent = await page.evaluate(() => document.body.innerText.toLowerCase());
        
        // Check if we're on a login page
        if (pageContent.includes('log in') || pageContent.includes('sign in')) {
            console.error('ERROR: Not authenticated. Please run manual login first.');
            console.error('Run: docker-compose exec nytimes-redeem node redeem.js --manual-login');
            await page.screenshot({ path: '/app/cookies/login-required.png' });
            return false;
        }
        
        // Check if already redeemed
        if (pageContent.includes('already redeemed') || 
            pageContent.includes('already claimed') ||
            pageContent.includes('previously redeemed') ||
            pageContent.includes('already used')) {
            console.log('ℹ Token already redeemed today - nothing to do');
            await page.screenshot({ path: '/app/cookies/already-redeemed.png' });
            await saveCookies(page);
            return true; // Not an error - just already done
        }
        
        // Check if there's an error message
        if (pageContent.includes('error') || 
            pageContent.includes('invalid') ||
            pageContent.includes('expired')) {
            console.error('ERROR: Page shows an error message');
            console.log('Page content preview:', pageContent.substring(0, 500));
            await page.screenshot({ path: '/app/cookies/error-page.png' });
            return false;
        }
        
        // Look for the redeem button
        console.log('Looking for redeem button...');
        
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
            console.log('Could not find redeem button. Taking screenshot...');
            await page.screenshot({ path: '/app/cookies/page-state.png' });
            
            // Log page content for debugging
            console.log('Page content preview:', pageContent.substring(0, 500));
            
            console.error('ERROR: Could not find redeem button');
            return false;
        }
        
        // Click the redeem button
        console.log('Found redeem button, clicking...');
        await redeemButton.click();
        
        // Wait for navigation or confirmation
        await page.waitForTimeout(5000);
        
        // Check the result
        const resultContent = await page.evaluate(() => document.body.innerText.toLowerCase());
        
        // Check for already redeemed message after click
        if (resultContent.includes('already redeemed') || 
            resultContent.includes('already claimed')) {
            console.log('ℹ Token already redeemed (detected after button click)');
            await page.screenshot({ path: '/app/cookies/already-redeemed.png' });
            await saveCookies(page);
            return true; // Not an error
        }
        
        // Check for success
        const isSuccess = resultContent.includes('success') || 
                         resultContent.includes('redeemed') ||
                         resultContent.includes('activated') ||
                         resultContent.includes('thank you') ||
                         resultContent.includes('congratulations');
        
        if (isSuccess) {
            console.log('✓ Redemption successful!');
        } else {
            console.log('⚠ Button clicked, but confirmation unclear. Check screenshot.');
        }
        
        // Take a screenshot of the result
        await page.screenshot({ path: '/app/cookies/redemption-result.png' });
        
        // Save cookies for next time
        await saveCookies(page);
        
        console.log('=== Redemption process completed ===\n');
        return true;
        
    } catch (error) {
        console.error('Error during redemption:', error);
        return false;
    } finally {
        if (browser) {
            await browser.close();
        }
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

// Main execution
if (process.argv.includes('--manual-login')) {
    manualLogin();
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
