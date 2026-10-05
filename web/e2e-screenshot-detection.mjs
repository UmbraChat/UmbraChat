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

await startChat(alice.page, bob.accountId);
await alice.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });

const disclosureVisible = await alice.page.locator('[data-testid="screenshot-disclosure"]').isVisible();
check("the screenshot-detection disclosure is visible on entering a conversation, with no action needed to trigger it", disclosureVisible);

const disclosureText = await alice.page.textContent('[data-testid="screenshot-disclosure"]');
check("the disclosure names the actual limitation, not a generic warning", disclosureText.toLowerCase().includes("screenshot") && disclosureText.toLowerCase().includes("web"), disclosureText);

await browser.close();

const failed = checks.some((ok) => !ok);
process.exit(failed ? 1 : 0);
