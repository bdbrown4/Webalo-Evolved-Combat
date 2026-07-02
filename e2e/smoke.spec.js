// Smoke test: the game boots, the menu renders, a Survival run actually starts
// (renderer + level build + HUD), and nothing throws along the way. This is the
// only automated coverage that exercises the real Three.js render path.
import { test, expect } from '@playwright/test';

test('boots to the menu and starts a Survival run without errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto('/');
  await expect(page.getByText('Evolved Combat').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /New Campaign/ })).toBeVisible();

  // menu → Survival → Play Solo
  await page.getByRole('button', { name: /Survival/ }).click();
  await page.getByRole('button', { name: /Play Solo/ }).click();

  // the HUD comes up and the wave readout goes live (the sim is really running)
  await expect(page.locator('#hud')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.survival-hud')).toContainText('WAVE', { timeout: 20_000 });

  // give the first wave a moment to spawn + render a few hundred frames
  await page.waitForTimeout(3000);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('daily challenge screen renders both cards', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Daily Challenge/ }).click();
  await expect(page.getByText('Survival of the Day')).toBeVisible();
  await expect(page.getByText('Mission of the Day')).toBeVisible();
  // both Play buttons live
  expect(await page.getByRole('button', { name: /^▶ Play$/ }).count()).toBe(2);
});
