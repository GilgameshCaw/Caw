import { chromium } from 'playwright-core';

(async () => {
  let browser;
  try {
    // Try to connect to an existing Chrome instance or launch
    browser = await chromium.launch({
      headless: true,
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    });

    const page = await browser.newPage();

    // Listen for console messages
    page.on('console', msg => {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        console.log(`[CONSOLE ${type.toUpperCase()}]: ${msg.text()}`);
      }
    });

    // Listen for page errors
    page.on('pageerror', error => {
      console.log(`[PAGE ERROR]: ${error.message}`);
      console.log(error.stack);
    });

    console.log('Loading http://localhost:5173/...');
    await page.goto('http://localhost:5173/', {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });

    console.log('[SUCCESS] Page loaded');

    // Wait a bit for any async errors
    await page.waitForTimeout(3000);

    console.log('[DONE] Closing browser');
  } catch (error) {
    console.log(`[ERROR]: ${error.message}`);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
})();
