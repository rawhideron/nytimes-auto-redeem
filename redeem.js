const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

const COOKIES_PATH = path.join(__dirname, 'cookies', 'nytimes-cookies.json');
const REDEEM_URL = 'https://www.nytimes.com/subscription/redeem?campaignId=6Y9QR&gift_code=24170f51d678a288';

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
        
        // Check if we're on a login page
        const isLoginPage = await page.evaluate(() => {
            return document.body.innerText.includes('Log in') || 
                   document.body.innerText.includes('Sign in');
        });
        
        if (isLoginPage) {
            console.error('ERROR: Not authenticated. Please run manual login first.');
            console.error('Run: docker-compose exec nytimes-redeem node redeem.js --manual-login');
            await page.screenshot({ path: '/app/cookies/login-required.png' });
            return false;
        }
        
        // Look for the redeem button - try multiple selectors
        console.log('Looking for redeem button...');
        
        const buttonSelectors = [
            'button:has-text("Redeem")',
            'button:has-text("redeem")',
            'a:has-text("Redeem")',
            'a:has-text("redeem")',
            'button[type="submit"]',
            '.redeem-button',
            '[data-testid*="redeem"]'
        ];
        
        let redeemButton = null;
        
        // Try to find button by text content
        redeemButton = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button, a'));
            return buttons.find(button => 
                button.textContent.toLowerCase().includes('redeem')
            );
        });
        
        if (!redeemButton || !(await redeemButton.asElement())) {
            console.log('Could not find redeem button by text. Taking screenshot...');
            await page.screenshot({ path: '/app/cookies/page-state.png' });
            
            // Log page content for debugging
            const bodyText = await page.evaluate(() => document.body.innerText);
            console.log('Page content preview:', bodyText.substring(0, 500));
            
            console.error('ERROR: Could not find redeem button');
            return false;
        }
        
        // Click the redeem button
        console.log('Found redeem button, clicking...');
        await redeemButton.click();
        
        // Wait for navigation or confirmation
        await page.waitForTimeout(5000);
        
        // Check for success message
        const pageContent = await page.evaluate(() => document.body.innerText);
        const isSuccess = pageContent.toLowerCase().includes('success') || 
                         pageContent.toLowerCase().includes('redeemed') ||
                         pageContent.toLowerCase().includes('thank you');
        
        if (isSuccess) {
            console.log('✓ Redemption successful!');
        } else {
            console.log('Button clicked, but confirmation unclear. Check screenshot.');
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
```

And make sure your **crontab** file is separate:
```
# Run at 6 AM ET daily (11 AM UTC, adjust based on DST)
# 0 11 * * * cd /app && /usr/local/bin/node /app/redeem.js >> /var/log/cron.log 2>&1
