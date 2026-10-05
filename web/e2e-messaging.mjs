import { chromium } from "playwright";
import { startChat } from "./ui-steps.mjs";

const checks = [];
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${ok ? "" : ` (${detail ?? ""})`}`);
  checks.push(ok);
}

const browser = await chromium.launch();

async function createAccount(context, label) {
  const page = await context.newPage();
  page.on("pageerror", (err) => console.log(`DEBUG ${label} page error:`, err));
  await page.goto("http://localhost:5173");
  await page.click("button");
  await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  const accountId = await page.textContent('[data-testid="account-id"]');
  return { page, accountId: accountId.trim() };
}

const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();

const alice = await createAccount(aliceContext, "alice");
const bob = await createAccount(bobContext, "bob");

check("alice and bob got different account ids", alice.accountId !== bob.accountId, `alice=${alice.accountId} bob=${bob.accountId}`);

// Alice starts a conversation with Bob.
await startChat(alice.page, bob.accountId);
await alice.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });

await alice.page.fill('input[placeholder="Type a message..."]', "hello bob, this is alice");
await alice.page.click('button[aria-label="Send"]');

await alice.page.waitForSelector('[data-testid="message-sent"]', { timeout: 15000 });
const aliceSentText = await alice.page.textContent('[data-testid="message-sent"]');
check("alice sees her own sent message", aliceSentText.includes("hello bob, this is alice"), aliceSentText);

// Bob starts a conversation back with Alice (single-conversation MVP: he needs to point at her too) and polls.
await startChat(bob.page, alice.accountId);
await bob.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });

await bob.page.waitForSelector('[data-testid="message-received"]', { timeout: 15000 });
const bobReceivedText = await bob.page.textContent('[data-testid="message-received"]');
check("bob receives and decrypts alice's message", bobReceivedText.includes("hello bob, this is alice"), bobReceivedText);

// Alice's sent message should reach "read" status once bob's client processes it and replies with receipts.
await alice.page.waitForFunction(
  () => document.querySelector('[data-testid="message-status"]')?.textContent?.includes("read"),
  { timeout: 15000 },
);
const aliceStatus = await alice.page.textContent('[data-testid="message-status"]');
check("alice's message reaches read status", aliceStatus.includes("read"), aliceStatus);

// Bob replies.
await bob.page.fill('input[placeholder="Type a message..."]', "hi alice, bob here");
await bob.page.click('button[aria-label="Send"]');

await alice.page.waitForFunction(
  () => document.querySelector('[data-testid="message-received"]')?.textContent?.includes("bob here"),
  { timeout: 15000 },
);
const aliceReceivedReply = await alice.page.textContent('[data-testid="message-received"]');
check("alice receives bob's reply", aliceReceivedReply.includes("bob here"), aliceReceivedReply);

// Reload alice's page: session and history must survive without re-establishing X3DH.
await alice.page.reload();
await alice.page.waitForSelector('[data-testid="message-list"]', { timeout: 15000 });
const messageCountAfterReload = await alice.page.locator("li").count();
check("alice's message history persists across reload", messageCountAfterReload >= 2, `count=${messageCountAfterReload}`);

await browser.close();

const failed = checks.some((ok) => !ok);
process.exit(failed ? 1 : 0);
