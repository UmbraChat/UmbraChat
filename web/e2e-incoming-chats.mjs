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
// Bob stays idle on the identity-ready screen - never types Alice's id, never
// clicks Start Conversation. Only Alice knows Bob's id.

await startChat(alice.page, bob.accountId);
await alice.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });
await alice.page.fill('input[placeholder="Type a message..."]', "hey it's alice");
await alice.page.click('button[aria-label="Send"]');

await bob.page.waitForSelector('[data-testid="incoming-chat-row"]', { timeout: 15000 });
const rowText = await bob.page.textContent('[data-testid="incoming-chat-row"]');
check("bob sees a pending-chat notice naming alice's account id", rowText.includes(alice.accountId), rowText);

await bob.page.click('[data-testid="incoming-chat-row"]');
await bob.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });
const bobMessages = await bob.page.locator('[data-testid="message-received"]').allTextContents();
check("bob's opened conversation already shows alice's message (no wait for next poll)", bobMessages.some((t) => t.includes("hey it's alice")), JSON.stringify(bobMessages));

// alice's message should reach "read" without her ever having to do anything else.
await alice.page.waitForFunction(() => document.querySelector('[data-testid="message-status"]')?.textContent?.includes("read"), { timeout: 10000 }).catch(() => {});
const aliceStatus = await alice.page.textContent('[data-testid="message-status"]');
check("alice's first message reaches 'read' even though bob never had the conversation open when it arrived", aliceStatus.includes("read"), aliceStatus);

// --- regression: bob is busy in alice's conversation (not idle on the menu)
// when a third person messages him for the first time. This is the common
// case in practice - a resumed session lands straight back in the last open
// conversation (ACTIVE_CONTACT_KEY), so most real usage never touches the
// idle identity-ready screen at all. onIncomingChat has to fire from every
// screen's poll, not just identity-ready's, or the notice never surfaces.
const daveCtx = await browser.newContext();
const dave = await createAccount(daveCtx);
await startChat(dave.page, bob.accountId);
await dave.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });
await dave.page.fill('input[placeholder="Type a message..."]', "hi, this is dave");
await dave.page.click('button[aria-label="Send"]');

// bob is still sitting in alice's conversation right now, not on the menu.
await bob.page.waitForTimeout(3500); // let bob's poll (in alice's conversation) pick up dave's message
await bob.page.click('[aria-label="Back to menu"]');
await bob.page.waitForSelector('[data-testid="incoming-chat-row"]', { timeout: 15000 });
const daveRowText = await bob.page.textContent('[data-testid="incoming-chat-row"]');
check("bob sees dave's pending-chat notice after returning to the menu, even though he was busy with alice when it arrived", daveRowText.includes(dave.accountId), daveRowText);

await browser.close();
const failed = checks.some((c) => !c);
process.exit(failed ? 1 : 0);
