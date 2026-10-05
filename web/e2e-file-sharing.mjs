import { chromium } from "playwright";

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

// bypassCSP: this test reads the download back with an in-page fetch(blob:), which the production CSP (connect-src 'self') blocks; the app itself never does that.
const aliceContext = await browser.newContext({ bypassCSP: true });
const bobContext = await browser.newContext({ bypassCSP: true });

const alice = await createAccount(aliceContext);
const bob = await createAccount(bobContext);

await alice.page.fill('input[placeholder="Recipient account id"]', bob.accountId);
await alice.page.click("text=Start Conversation");
await alice.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });

await bob.page.fill('input[placeholder="Recipient account id"]', alice.accountId);
await bob.page.click("text=Start Conversation");
await bob.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });

// A small, distinctive binary payload - not valid UTF-8, to prove raw bytes
// survive the round trip, not just text-safe content.
const originalBytes = Array.from({ length: 4096 }, (_, i) => i % 256);
const fileBuffer = Buffer.from(originalBytes);

await alice.page.setInputFiles('input[type="file"]', {
  name: "test-image.png",
  mimeType: "image/png",
  buffer: fileBuffer,
});

await alice.page.waitForSelector('[data-testid="file-message"]', { timeout: 15000 });
const aliceFileText = await alice.page.textContent('[data-testid="file-message"]');
check("alice sees her own sent file with name and size", aliceFileText.includes("test-image.png") && aliceFileText.includes("4.0KB"), aliceFileText);

await bob.page.waitForSelector('[data-testid="file-download"]', { timeout: 15000 });
const bobFileText = await bob.page.textContent('[data-testid="file-message"]');
check("bob receives the file with the correct name and size", bobFileText.includes("test-image.png") && bobFileText.includes("4.0KB"), bobFileText);

const downloadUrl = await bob.page.getAttribute('[data-testid="file-download"]', "href");
const downloadedBytes = await bob.page.evaluate(async (url) => {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  return Array.from(new Uint8Array(buffer));
}, downloadUrl);

check(
  "the downloaded file is byte-for-byte identical to the original",
  JSON.stringify(downloadedBytes) === JSON.stringify(originalBytes),
  `lengths: original=${originalBytes.length} downloaded=${downloadedBytes.length}`,
);

// Oversized file: rejected client-side, no request ever sent.
const oversizedBuffer = Buffer.alloc(9 * 1024 * 1024, 1);
await alice.page.setInputFiles('input[type="file"]', {
  name: "too-big.bin",
  mimeType: "application/octet-stream",
  buffer: oversizedBuffer,
});
await alice.page.waitForSelector('[role="alert"]', { timeout: 5000 });
const oversizedError = await alice.page.textContent('[role="alert"]');
check("an oversized file shows a clear error", oversizedError.toLowerCase().includes("too large"), oversizedError);

const fileMessagesAfterOversized = await alice.page.locator('[data-testid="file-message"]').count();
check("the oversized file was never sent (message count unchanged)", fileMessagesAfterOversized === 1, `count=${fileMessagesAfterOversized}`);

await browser.close();

const failed = checks.some((ok) => !ok);
process.exit(failed ? 1 : 0);
