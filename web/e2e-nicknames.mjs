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
  await page.click("text=Create Account");
  await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  const accountId = (await page.textContent('[data-testid="account-id"]')).trim();
  return { page, accountId };
}

const aliceCtx = await browser.newContext();
const bobCtx = await browser.newContext();
const alice = await createAccount(aliceCtx);
const bob = await createAccount(bobCtx);

await startChat(alice.page, bob.accountId);
await alice.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });
await alice.page.fill('input[placeholder="Type a message..."]', "hey it's alice");
await alice.page.click('button[aria-label="Send"]');

await bob.page.waitForSelector('[data-testid="incoming-chat-row"]', { timeout: 15000 });
const rowBefore = await bob.page.textContent('[data-testid="incoming-chat-row"]');
check("before any nickname, bob's pending-chat row shows alice's raw account id", rowBefore.includes(alice.accountId), rowBefore);

await bob.page.click('[data-testid="incoming-chat-row"]');
await bob.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });
const titleBefore = await bob.page.textContent('[data-testid="conversation-title"]');
check("with no nickname set, the conversation header shows the raw account id", titleBefore.trim() === alice.accountId, titleBefore);

await contactSettings(bob.page);
await bob.page.fill('input[aria-label="Nickname"]', "Alice");
await bob.page.press('input[aria-label="Nickname"]', "Enter");
await bob.page.click('button[aria-label="Back to chat"]');
await bob.page.waitForFunction(
  () => document.querySelector('[data-testid="conversation-title"]')?.textContent?.trim() === "Alice",
  { timeout: 5000 },
);
check("setting a nickname updates the header immediately", true);

await bob.page.click('button[aria-label="Back to menu"]');
await alice.page.fill('input[placeholder="Type a message..."]', "second message");
await alice.page.click('button[aria-label="Send"]');
await bob.page.waitForSelector('[data-testid="incoming-chat-row"]', { timeout: 15000 });
const rowAfter = await bob.page.textContent('[data-testid="incoming-chat-row"]');
check("a pending-chat row shows the nickname once one is set for that sender", rowAfter.includes("Alice") && !rowAfter.includes(alice.accountId), rowAfter);

await bob.page.click('[data-testid="incoming-chat-row"]');
await bob.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });
await contactSettings(bob.page);
await bob.page.fill('input[aria-label="Nickname"]', "");
await bob.page.press('input[aria-label="Nickname"]', "Enter");
await bob.page.click('button[aria-label="Back to chat"]');
await bob.page.waitForFunction(
  (id) => document.querySelector('[data-testid="conversation-title"]')?.textContent?.trim() === id,
  alice.accountId,
  { timeout: 5000 },
);
check("clearing the nickname (empty field) reverts the header back to the raw account id", true);

console.log(checks.every(Boolean) ? "\nAll checks passed." : "\nSome checks FAILED.");
await browser.close();
process.exit(checks.every(Boolean) ? 0 : 1);
