/**
 * E2E spec: Multi-user platform flows (browser-level).
 *
 * Tests the full user journey through the browser UI:
 *   1. Register a new user at /register
 *   2. Login at /login with email + password
 *   3. View account page (balance, API keys, providers)
 *   4. Browse marketplace
 *
 * Prerequisites:
 *   - OMNIROUTE_MULTI_USER=true in .env
 *   - Server running at localhost:20128
 *   - Fresh DB (or unique email per run)
 *
 * This spec is excluded from the default CI E2E run (which assumes
 * single-user mode). Run manually with:
 *   OMNIROUTE_MULTI_USER=true npx playwright test tests/e2e/multi-user-flows.spec.ts
 */
import { expect, test } from "@playwright/test";

const BASE_URL = process.env.BASE_URL || "http://localhost:20128";
const TEST_EMAIL = `e2e-${Date.now()}@test.example`;
const TEST_PASSWORD = "e2e-test-password-123";

test.describe("Multi-User Platform Flows", () => {
  test.describe.configure({ mode: "serial" });

  test("FLOW 1: register a new user via /register", async ({ page }) => {
    await page.goto(`${BASE_URL}/register`);

    // Fill registration form
    await page.fill('input[type="email"]', TEST_EMAIL);
    await page.fill('input[type="text"]', "E2E Test User");
    await page.fill('input[type="password"]', TEST_PASSWORD);

    // Submit
    await page.click('button[type="submit"]');

    // Should redirect to dashboard
    await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
    await expect(page.locator("body")).toBeVisible();
  });

  test("FLOW 2: logout and login via /login with email + password", async ({ page, context }) => {
    // Clear cookies to force re-login
    await context.clearCookies();

    await page.goto(`${BASE_URL}/login`);

    // Fill login form with email + password
    await page.fill('input[type="email"]', TEST_EMAIL);
    await page.fill('input[type="password"]', TEST_PASSWORD);

    // Submit
    await page.click('button[type="submit"]');

    // Should redirect to dashboard
    await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
    await expect(page.locator("body")).toBeVisible();
  });

  test("FLOW 3: account page shows user profile and wallet balance", async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/account`);

    // Wait for page to load
    await page.waitForLoadState("networkidle");

    // Should show the user's email
    await expect(page.locator("text=My account")).toBeVisible({ timeout: 30_000 });

    // Should show wallet balance (starts at $0.00)
    await expect(page.locator("text=Wallet balance")).toBeVisible();
    await expect(page.locator("text=$0.00").first()).toBeVisible({ timeout: 10_000 });
  });

  test("FLOW 4: wallet page shows balance and transaction history", async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/wallet`);

    await page.waitForLoadState("networkidle");

    // Should show wallet title
    await expect(page.locator("text=Wallet")).toBeVisible({ timeout: 30_000 });

    // Should show current balance
    await expect(page.locator("text=Current balance")).toBeVisible();

    // Should show transaction table (even if empty)
    // "No transactions yet" or a table
    const noTxText = page.locator("text=No transactions yet");
    const txTable = page.locator("table");
    await expect(noTxText.or(txTable)).toBeVisible({ timeout: 10_000 });
  });

  test("FLOW 5: marketplace page shows public listings", async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/marketplace`);

    await page.waitForLoadState("networkidle");

    // Should show marketplace title
    await expect(page.locator("text=Marketplace")).toBeVisible({ timeout: 30_000 });

    // Should show search input
    await expect(page.locator('input[type="text"]').first()).toBeVisible();
  });

  test("FLOW 6: login fails with wrong password", async ({ page, context }) => {
    await context.clearCookies();

    await page.goto(`${BASE_URL}/login`);

    await page.fill('input[type="email"]', TEST_EMAIL);
    await page.fill('input[type="password"]', "wrong-password-xyz");

    await page.click('button[type="submit"]');

    // Should show error message (not redirect to dashboard)
    await expect(page.locator("text=/invalid|error|failed/i")).toBeVisible({ timeout: 10_000 });
    // Should still be on login page
    await expect(page).not.toHaveURL(/\/dashboard/);
  });

  test("FLOW 7: register rejects duplicate email", async ({ page, context }) => {
    await context.clearCookies();

    await page.goto(`${BASE_URL}/register`);

    // Try to register with the same email
    await page.fill('input[type="email"]', TEST_EMAIL);
    await page.fill('input[type="password"]', "another-password-123");

    await page.click('button[type="submit"]');

    // Should show error about duplicate email
    await expect(page.locator("text=/already exists|email_taken|duplicate/i")).toBeVisible({ timeout: 10_000 });
    // Should still be on register page
    await expect(page).not.toHaveURL(/\/dashboard/);
  });

  test("FLOW 8: register rejects short password", async ({ page, context }) => {
    await context.clearCookies();

    await page.goto(`${BASE_URL}/register`);

    await page.fill('input[type="email"]', `short-${Date.now()}@test.example`);
    await page.fill('input[type="password"]', "123");

    await page.click('button[type="submit"]');

    // Browser's minLength validation should prevent submit
    // or show an error
    await expect(page).not.toHaveURL(/\/dashboard/);
  });
});
