import { chromium } from "playwright";
import { startChat } from "./ui-steps.mjs";

const checks = [];
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${ok ? "" : ` (${detail ?? ""})`}`);
  checks.push(ok);
}

const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});

async function createAccount() {
  const context = await browser.newContext();
  await context.grantPermissions(["camera", "microphone"]);
  const page = await context.newPage();
  await page.goto("http://localhost:5173");
  await page.click("button");
  await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  const accountId = (await page.textContent('[data-testid="account-id"]')).trim();
  return { page, accountId };
}

const alice = await createAccount();
const bob = await createAccount();

await startChat(alice.page, bob.accountId);
await alice.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });

// bob never opens a conversation: he stays on the home screen the whole time.
await alice.page.click('[aria-label="Video call"]');
await bob.page.waitForSelector('[data-testid="incoming-call-banner"]', { timeout: 15000 });
check("a callee on the home screen sees the incoming call", true);

await bob.page.click("text=Accept");
for (const { page } of [alice, bob]) {
  await page.waitForFunction(() => document.querySelector('[data-testid="call-status-label"]')?.textContent === "Connected", { timeout: 15000 });
}
check("both sides reach Connected after accepting from the home screen", true);
check("accepting opened the caller's conversation", (await bob.page.locator('input[placeholder="Type a message..."]').count()) > 0);

await browser.close();
process.exit(checks.every(Boolean) ? 0 : 1);
