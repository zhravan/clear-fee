const { test, expect } = require('@playwright/test');

test('invoice editor loads and calculates a line item', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#fromName')).toBeVisible();
  await expect(page.locator('#pvTotal')).toBeVisible();
  await expect(page.locator('#items .item')).toHaveCount(2);
  await page.locator('#items input[data-k="qty"]').first().fill('2');
  await expect(page.locator('#pvTotal')).not.toHaveText('');
});

test('workspace exposes local client and invoice controls', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#clientForm')).toBeVisible();
  await expect(page.locator('#invoiceList')).toBeVisible();
  await expect(page.locator('#backupBtn')).toBeVisible();
});
