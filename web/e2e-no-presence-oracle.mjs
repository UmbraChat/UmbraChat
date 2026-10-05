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
  await page.click("text=Create Account");
  await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  const accountId = (await page.textContent('[data-testid="account-id"]')).trim();
  return { page, accountId };
}

const aliceCtx = await browser.newContext();
const bobCtx = await browser.newContext();
const alice = await createAccount(aliceCtx);
const bob = await createAccount(bobCtx);
// Bob stays idle - never opens the conversation, never clicks anything.

await startChat(alice.page, bob.accountId);
await alice.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });
await alice.page.fill('input[placeholder="Type a message..."]', "probe message");
await alice.page.click('button[aria-label="Send"]');

// Give bob's idle poll (and a couple more ticks) plenty of time to process
// the message - this is the presence-oracle window: does "read" leak before
// bob ever opens anything?
await bob.page.waitForSelector('[data-testid="incoming-chat-row"]', { timeout: 15000 });
await bob.page.waitForTimeout(4000);

const aliceStatus = await alice.page.textContent('[data-testid="message-status"]');
check(
  "alice's message does NOT show 'read' before bob ever opens the conversation (presence-oracle fix)",
  !aliceStatus.includes("read"),
  aliceStatus,
);
check("it does show 'delivered' though - that part stays automatic", aliceStatus.includes("delivered"), aliceStatus);

// Now bob actually opens it - only now should "read" appear.
await bob.page.click('[data-testid="incoming-chat-row"]');
await alice.page.waitForFunction(() => document.querySelector('[data-testid="message-status"]')?.textContent?.includes("read"), { timeout: 10000 });
const aliceStatusAfter = await alice.page.textContent('[data-testid="message-status"]');
check("alice's message reaches 'read' once bob actually opens the conversation", aliceStatusAfter.includes("read"), aliceStatusAfter);

await browser.close();
const failed = checks.some((c) => !c);
process.exit(failed ? 1 : 0);
