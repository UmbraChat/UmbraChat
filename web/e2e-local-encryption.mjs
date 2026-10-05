import { chromium } from "playwright";
import { openTab } from "./ui-steps.mjs";

const checks = [];
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${ok ? "" : ` (${detail ?? ""})`}`);
  checks.push(ok);
}

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
await page.goto("http://localhost:5173");
await page.click("text=Create Account");
await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });

// Reads the raw stored account record directly out of IndexedDB, bypassing
// the app's own (self-decrypting) read path - the only way to actually
// verify the on-disk bytes are ciphertext, not just that round-tripping
// through the app still works.
async function readRawAccountRecord(p) {
  return p.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("umbrachat", 2);
        req.onsuccess = () => {
          const tx = req.result.transaction("identity", "readonly");
          const getReq = tx.objectStore("identity").get("self");
          getReq.onsuccess = () => resolve(getReq.result);
          getReq.onerror = () => reject(getReq.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );
}

const before = await readRawAccountRecord(page);
check("before enabling, the raw account record is plain (no __encrypted marker)", before && before.__encrypted !== true, JSON.stringify(before).slice(0, 80));

// --- Enable ---
await openTab(page, "settings");
await page.waitForSelector('[data-testid="encryption-status"]', { timeout: 15000 });
const statusBefore = await page.textContent('[data-testid="encryption-status"]');
check("status starts Off", statusBefore.trim() === "Off", statusBefore);

await page.click("text=Enable");
await page.fill('input[placeholder="Passphrase"]', "correct horse battery staple");
const enableButton = page.locator('button:has-text("Enable Encryption")');
check("Enable button stays disabled until confirm matches", await enableButton.isDisabled());
await page.fill('input[placeholder="Confirm passphrase"]', "correct horse battery staple");
check("Enable button becomes enabled once passphrases match", await enableButton.isEnabled());
await enableButton.click();
await page.waitForSelector('[data-testid="encryption-status"]', { timeout: 15000 });
const statusAfter = await page.textContent('[data-testid="encryption-status"]');
check("status becomes On after enabling", statusAfter.trim() === "On", statusAfter);

const afterEnable = await readRawAccountRecord(page);
check("after enabling, the raw account record IS an EncryptedBlob", afterEnable && afterEnable.__encrypted === true, JSON.stringify(afterEnable).slice(0, 80));

// The app itself can still read through it correctly (round trip via the
// vault stays valid within this same unlocked session).
await openTab(page, "me");
await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
const accountIdBeforeReload = (await page.textContent('[data-testid="account-id"]')).trim();
check("the app itself still reads the account correctly right after enabling", accountIdBeforeReload.length > 0, accountIdBeforeReload);

// --- Reload: a fresh page load always starts locked when encryption is on,
// since the key only ever lives in memory, never localStorage. ---
await page.reload();
await page.waitForSelector('h1:has-text("Locked")', { timeout: 15000 });

// Wrong passphrase first.
await page.fill('input[placeholder="Passphrase"]', "not the right passphrase");
await page.click("text=Unlock");
await page.waitForSelector('[role="alert"]', { timeout: 10000 });
const wrongPassError = await page.textContent('[role="alert"]');
check("wrong passphrase shows an error and stays locked", wrongPassError.toLowerCase().includes("wrong"), wrongPassError);
check("still on the Locked screen after a failed attempt", await page.locator('h1:has-text("Locked")').isVisible());

// Then the correct one.
await page.fill('input[placeholder="Passphrase"]', "correct horse battery staple");
await page.click("text=Unlock");
await openTab(page, "me");
await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
const accountIdAfterUnlock = (await page.textContent('[data-testid="account-id"]')).trim();
check("correct passphrase unlocks and boots into the same account as before", accountIdAfterUnlock === accountIdBeforeReload, `before=${accountIdBeforeReload} after=${accountIdAfterUnlock}`);

// --- Disable ---
await openTab(page, "settings");
await page.waitForSelector('[data-testid="encryption-status"]', { timeout: 15000 });
await page.click("text=Disable");
await page.waitForFunction(() => document.querySelector('[data-testid="encryption-status"]')?.textContent?.trim() === "Off", { timeout: 15000 });

const afterDisable = await readRawAccountRecord(page);
check("after disabling, the raw account record is plain again", afterDisable && afterDisable.__encrypted !== true, JSON.stringify(afterDisable).slice(0, 80));

await browser.close();
const failed = checks.some((c) => !c);
process.exit(failed ? 1 : 0);
