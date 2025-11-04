const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  // Collect console messages
  page.on('console', msg => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') {
      console.log(`[BROWSER ${type.toUpperCase()}]:`, msg.text());
    }
  });

  // Collect page errors
  page.on('pageerror', error => {
    console.log('[PAGE ERROR]:', error.message);
  });

  try {
    await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0', timeout: 30000 });
    console.log('[SUCCESS] Page loaded successfully');

    // Wait a bit to catch any delayed errors
    await page.waitForTimeout(3000);
  } catch (error) {
    console.log('[NAVIGATION ERROR]:', error.message);
  }

  await browser.close();
})();
