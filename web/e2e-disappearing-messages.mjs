import { chromium } from "playwright";
import { startChat, contactSettings } from "./ui-steps.mjs";

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

// Rewrites a message's expiresAt to already-past directly in IndexedDB, so the
// test doesn't have to actually wait out a real 30s timer to exercise the
// sweep-and-delete path - it only needs to prove that an expired message is
// gone by the next poll, not that a clock can count down.
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

const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();

const alice = await createAccount(aliceContext);
const bob = await createAccount(bobContext);

await startChat(alice.page, bob.accountId);
await alice.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });

await startChat(bob.page, alice.accountId);
await bob.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });

// Sent before any timer is set - must survive the whole test untouched.
await alice.page.fill('input[placeholder="Type a message..."]', "permanent message");
await alice.page.click('button[aria-label="Send"]');
await bob.page.waitForSelector("text=permanent message", { timeout: 15000 });

await contactSettings(alice.page);
await alice.page.click('[data-testid="timer-picker"] [role="radio"]:has-text("30s")');
await alice.page.click('button[aria-label="Back to chat"]');
await bob.page.waitForTimeout(3500);
await contactSettings(bob.page);
const bobTimer = (await bob.page.textContent('[data-testid="timer-picker"] [aria-checked="true"]')).trim();
check("bob's timer picker syncs to alice's 30s setting after his next poll", bobTimer === "30s", bobTimer);
await bob.page.click('button[aria-label="Back to chat"]');

await alice.page.fill('input[placeholder="Type a message..."]', "will vanish");
await alice.page.click('button[aria-label="Send"]');
await bob.page.waitForSelector("text=will vanish", { timeout: 15000 });

const aliceMarkers = await alice.page.locator('[data-testid="disappearing-marker"]').count();
check("alice's own sent message shows the disappearing marker once a timer is active", aliceMarkers === 1, `count=${aliceMarkers}`);
const bobMarkers = await bob.page.locator('[data-testid="disappearing-marker"]').count();
check("bob's received message shows the disappearing marker too", bobMarkers === 1, `count=${bobMarkers}`);

// Alice's own copy only gets expiresAt once the read receipt round-trips back
// to her (the "pegged to read, not send" decision) - her poll runs on its own
// 3s cycle, independent of when bob received the message, so give it a tick.
await alice.page.waitForTimeout(3500);

await forceExpire(alice.page, bob.accountId);
await forceExpire(bob.page, alice.accountId);
await alice.page.waitForTimeout(3500);
await bob.page.waitForTimeout(500);

const aliceStillHasIt = await alice.page.locator('[data-testid="message-list"] >> text=will vanish').count();
check("the expired message is hard-deleted from alice's device on the next poll", aliceStillHasIt === 0, `count=${aliceStillHasIt}`);
const bobStillHasIt = await bob.page.locator('[data-testid="message-list"] >> text=will vanish').count();
check("the expired message is hard-deleted from bob's device on the next poll", bobStillHasIt === 0, `count=${bobStillHasIt}`);

const alicePermanent = await alice.page.locator('[data-testid="message-list"] >> text=permanent message').count();
check("the message sent before the timer was set is untouched", alicePermanent === 1, `count=${alicePermanent}`);
const bobPermanent = await bob.page.locator('[data-testid="message-list"] >> text=permanent message').count();
check("...on bob's device too", bobPermanent === 1, `count=${bobPermanent}`);

await browser.close();

const failed = checks.some((ok) => !ok);
process.exit(failed ? 1 : 0);
