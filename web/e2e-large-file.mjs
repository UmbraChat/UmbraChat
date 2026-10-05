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

await startChat(alice.page, bob.accountId);
await alice.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });
await startChat(bob.page, alice.accountId);
await bob.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });

// A realistic, non-image ~6MB payload, well under MAX_FILE_BYTES (8MB) - not
// a WebP conversion candidate, isolates the base64-vs-number-array bug from
// image conversion entirely. This is the exact size class every prior file-
// sharing test skipped (only ever tested a 4KB fixture or an intentionally-
// oversized 9MB buffer that gets rejected before sending).
const size = 6 * 1024 * 1024;
const bigBuffer = Buffer.from(Array.from({ length: size }, (_, i) => i % 256));

await alice.page.setInputFiles('input[type="file"]', {
  name: "big-file.bin",
  mimeType: "application/octet-stream",
  buffer: bigBuffer,
});

// Should reach "sent" well within a generous timeout, not hang forever.
await alice.page
  .waitForFunction(() => !document.querySelector('[data-testid="file-stage"]'), { timeout: 30000 })
  .catch(() => {});
const stillStuck = await alice.page.locator('[data-testid="file-stage"]').count();
check("a real ~6MB file finishes sending instead of getting stuck", stillStuck === 0, `file-stage still present: ${stillStuck > 0}`);

await bob.page.waitForSelector('[data-testid="file-message"]', { timeout: 20000 });
const bobFileText = await bob.page.textContent('[data-testid="file-message"]');
check("bob receives the file", bobFileText.includes("big-file.bin"), bobFileText);

await browser.close();
const failed = checks.some((c) => !c);
process.exit(failed ? 1 : 0);
