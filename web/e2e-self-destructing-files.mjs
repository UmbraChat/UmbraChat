import { chromium } from "playwright";
import { startChat } from "./ui-steps.mjs";

const checks = [];
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${ok ? "" : ` (${detail ?? ""})`}`);
  checks.push(ok);
}

const browser = await chromium.launch();

async function createAccount(context) {
  const page = await context.newPage();
  await page.goto("http://localhost:5173");
  await page.click("button");
  await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  const accountId = (await page.textContent('[data-testid="account-id"]')).trim();
  return { page, accountId };
}

// Same technique as the disappearing-messages suite: rewrite expiresAt to
// already-past directly in IndexedDB, so the test doesn't have to wait out a
// real 30s timer to exercise the sweep - it only needs to prove an expired
// file is gone by the next poll.
async function forceExpire(page, contactId) {
  await page.evaluate(async (contactId) => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("umbrachat-messages", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction("messages", "readwrite");
    const store = tx.objectStore("messages");
    const messages = await new Promise((resolve, reject) => {
      const r = store.get(contactId);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    for (const m of messages) if (m.expiresAt) m.expiresAt = new Date(Date.now() - 1000).toISOString();
    store.put(messages, contactId);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }, contactId);
}

const DESTRUCT_LABELS = { none: "Keep it", "on-open": "After opening", 30: "After 30s" };

async function sendFile(page, name, bytesLen, destructMode) {
  await page.click('button[aria-label="Send a file"]');
  await page.click(`[data-testid="file-destruct-mode"] [role="radio"]:has-text("${DESTRUCT_LABELS[destructMode]}")`);
  await page.setInputFiles('input[type="file"]', {
    name,
    mimeType: "application/octet-stream",
    buffer: Buffer.from(Array.from({ length: bytesLen }, (_, i) => i % 256)),
  });
}

const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();
const alice = await createAccount(aliceContext);
const bob = await createAccount(bobContext);

await startChat(alice.page, bob.accountId);
await alice.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });
await startChat(bob.page, alice.accountId);
await bob.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });

// --- baseline: no destruct mode, unaffected ---
await sendFile(alice.page, "permanent.bin", 256, "none");
await bob.page.waitForSelector('[data-testid="file-message"]', { timeout: 15000 });
const permanentHasMarker = await alice.page.locator('[data-testid="destruct-marker"]').count();
check("a file sent with destruct mode 'None' has no marker", permanentHasMarker === 0, `count=${permanentHasMarker}`);

// --- on-open ---
await sendFile(alice.page, "on-open.bin", 256, "on-open");
await bob.page.waitForFunction(() => document.querySelectorAll('[data-testid="destruct-marker"]').length >= 1, { timeout: 15000 });
const aliceMarkerCount = await alice.page.locator('[data-testid="destruct-marker"]').count();
check("the on-open file shows the destruct marker on the sender's side", aliceMarkerCount >= 1, `count=${aliceMarkerCount}`);

await bob.page.locator('[data-testid="message-received"]:has-text("on-open.bin") [data-testid="file-download"]').click();
await bob.page.waitForFunction(() => !document.querySelector('[data-testid="message-list"]').textContent.includes("on-open.bin"), { timeout: 15000 });
check("opening the on-open file removes it from the recipient's list immediately", true);

await alice.page.waitForFunction(
  () => Array.from(document.querySelectorAll('[data-testid="message-status"]')).some((el) => el.textContent.includes("opened")),
  { timeout: 15000 },
);
check("the sender's copy shows status 'opened'", true);

// --- destruct mode resets after each send, doesn't silently carry over ---
await alice.page.click('button[aria-label="Send a file"]');
const modeAfterSend = (await alice.page.textContent('[data-testid="file-destruct-mode"] [aria-checked="true"]')).trim();
await alice.page.keyboard.press("Escape");
check("the destruct-mode picker resets to 'Keep it' after sending, not a standing policy", modeAfterSend === "Keep it", modeAfterSend);

// --- timed ---
await sendFile(alice.page, "timed.bin", 256, "30");
await bob.page.waitForFunction(() => document.querySelectorAll('[data-testid="file-message"]').length === 2, { timeout: 15000 });

await forceExpire(alice.page, bob.accountId);
await forceExpire(bob.page, alice.accountId);
await alice.page.waitForTimeout(3500);
await bob.page.waitForTimeout(500);

const aliceTimedGone = await alice.page.locator('[data-testid="message-list"] >> text=timed.bin').count();
check("the timed file is hard-deleted from the sender's device after expiry", aliceTimedGone === 0, `count=${aliceTimedGone}`);
const bobTimedGone = await bob.page.locator('[data-testid="message-list"] >> text=timed.bin').count();
check("the timed file is hard-deleted from the recipient's device after expiry, unopened", bobTimedGone === 0, `count=${bobTimedGone}`);

const alicePermanentStillThere = await alice.page.locator('[data-testid="message-list"] >> text=permanent.bin').count();
check("the permanent file survives the whole run untouched", alicePermanentStillThere === 1, `count=${alicePermanentStillThere}`);

await browser.close();

const failed = checks.some((ok) => !ok);
process.exit(failed ? 1 : 0);
