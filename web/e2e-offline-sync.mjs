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

const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();

const alice = await createAccount(aliceContext);
const bob = await createAccount(bobContext);

// Alice messages Bob while Bob's conversation screen is not open at all -
// simulating Bob being offline/away, with messages queuing server-side.
await startChat(alice.page, bob.accountId);
await alice.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });
await alice.page.fill('input[placeholder="Type a message..."]', "queued while you were away");
await alice.page.click('button[aria-label="Send"]');
await alice.page.waitForSelector('[data-testid="message-sent"]', { timeout: 15000 });

// Now Bob "reconnects": opens the conversation for the first time.
const openedAt = Date.now();
await startChat(bob.page, alice.accountId);
await bob.page.waitForSelector('[data-testid="message-received"]', { timeout: 15000 });
const elapsedMs = Date.now() - openedAt;

const receivedText = await bob.page.textContent('[data-testid="message-received"]');
check("bob sees the queued message on reconnect", receivedText.includes("queued while you were away"), receivedText);
check("the queued message appears well under the 3s poll interval (immediate poll, not delayed)", elapsedMs < 2000, `elapsed=${elapsedMs}ms`);

await browser.close();

const failed = checks.some((ok) => !ok);
process.exit(failed ? 1 : 0);
