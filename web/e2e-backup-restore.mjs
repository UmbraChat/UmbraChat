import { chromium } from "playwright";
import { startChat, openTab, unfold } from "./ui-steps.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const checks = [];
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${ok ? "" : ` (${detail ?? ""})`}`);
  checks.push(ok);
}

const browser = await chromium.launch();

async function createAccount(context) {
  const page = await context.newPage();
  await page.goto("http://localhost:5173");
  await page.click("text=Create Account");
  await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  const accountId = (await page.textContent('[data-testid="account-id"]')).trim();
  const safetyNumber = (await page.textContent('[data-testid="safety-number"]')).trim();
  return { page, accountId, safetyNumber };
}

// --- Alice has a real conversation before "losing" her device ---
const aliceCtx = await browser.newContext();
const bobCtx = await browser.newContext();
const alice = await createAccount(aliceCtx);
const bob = await createAccount(bobCtx);

await startChat(alice.page, bob.accountId);
await alice.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });
await alice.page.fill('input[placeholder="Type a message..."]', "this should survive the backup");
await alice.page.click('button[aria-label="Send"]');
await alice.page.waitForTimeout(300);

// --- Export a backup ---
await openTab(alice.page, "settings");
await alice.page.waitForSelector('[data-testid="encryption-status"]', { timeout: 15000 });
await alice.page.fill('input[placeholder="Passphrase"]', "restore-me-please");

const downloadPromise = alice.page.waitForEvent("download");
await alice.page.click("text=Export Backup");
const download = await downloadPromise;
check("exporting triggers a real file download", download.suggestedFilename().endsWith(".json"), download.suggestedFilename());

const tmpDir = mkdtempSync(join(tmpdir(), "umbrachat-backup-"));
const backupPath = join(tmpDir, download.suggestedFilename());
await download.saveAs(backupPath);

// --- Simulate a lost device: a completely fresh context, no local data at all ---
const newDeviceCtx = await browser.newContext();
const newDevicePage = await newDeviceCtx.newPage();
await newDevicePage.goto("http://localhost:5173");
await newDevicePage.waitForSelector("text=Lost your device?", { timeout: 15000 });
await unfold(newDevicePage, "Lost your device?");

// Wrong passphrase first.
await newDevicePage.setInputFiles('input[aria-label="Backup file"]', backupPath);
await newDevicePage.fill('input[placeholder="Backup passphrase"]', "the-wrong-passphrase");
await newDevicePage.click("text=Restore from Backup");
await newDevicePage.waitForSelector('[role="alert"]', { timeout: 15000 });
const wrongPassError = await newDevicePage.textContent('[role="alert"]');
check("wrong passphrase is rejected with a clear error", wrongPassError.toLowerCase().includes("passphrase"), wrongPassError);

// Now the correct one.
await newDevicePage.fill('input[placeholder="Backup passphrase"]', "restore-me-please");
await newDevicePage.click("text=Restore from Backup");
await newDevicePage.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });

const restoredAccountId = (await newDevicePage.textContent('[data-testid="account-id"]')).trim();
const restoredSafetyNumber = (await newDevicePage.textContent('[data-testid="safety-number"]')).trim();
check("restored account id matches the original", restoredAccountId === alice.accountId, `original=${alice.accountId} restored=${restoredAccountId}`);
check("restored safety number matches the original", restoredSafetyNumber === alice.safetyNumber, `original=${alice.safetyNumber} restored=${restoredSafetyNumber}`);

// The conversation history should have come back too.
await startChat(newDevicePage, bob.accountId);
await newDevicePage.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });
const restoredMessages = await newDevicePage.locator('[data-testid="message-sent"]').allTextContents();
check("the message sent before the backup is restored on the new device", restoredMessages.some((t) => t.includes("this should survive the backup")), JSON.stringify(restoredMessages));

await browser.close();
const failed = checks.some((c) => !c);
process.exit(failed ? 1 : 0);
