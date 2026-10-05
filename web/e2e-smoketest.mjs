import { chromium } from "playwright";
import { Client } from "pg";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://umbrachat:umbrachat@localhost:5432/umbrachat";

const db = new Client({ connectionString: DATABASE_URL });
await db.connect();

async function identityKeysCount() {
  const { rows } = await db.query("SELECT count(*) FROM identity_keys");
  return Number(rows[0].count);
}

const browser = await chromium.launch();
const page = await browser.newPage();

const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(String(err)));

await page.goto("http://localhost:5173");
await page.waitForSelector("button");

const checks = [];

checks.push(["no console errors after initial load", consoleErrors.length === 0, consoleErrors.join("; ")]);

const countBefore = await identityKeysCount();

await page.click("button");
try {
  await page.waitForSelector('[data-testid="safety-number"]', { timeout: 15000 });
} catch (e) {
  console.log("DEBUG console errors:", consoleErrors);
  console.log("DEBUG body html:", await page.content());
  throw e;
}

const safetyNumber = await page.textContent('[data-testid="safety-number"]');
checks.push(["safety number is non-empty", !!safetyNumber && safetyNumber.trim().length > 0, safetyNumber]);

const countAfter = await identityKeysCount();
checks.push(["exactly one new identity_keys row was created", countAfter === countBefore + 1, `before=${countBefore} after=${countAfter}`]);

const { rows: newRows } = await db.query(
  `SELECT ik.public_key, ik.registration_id
   FROM identity_keys ik
   JOIN devices d ON d.id = ik.device_id
   JOIN accounts a ON a.id = d.account_id
   ORDER BY a.created_at DESC
   LIMIT 1`,
);
const publicKeyLength = newRows[0]?.public_key?.length;
checks.push([
  "the new row holds public-key-shaped bytes (33 bytes: 1 type byte + 32-byte Curve25519 key)",
  publicKeyLength === 33,
  `length=${publicKeyLength}`,
]);

const { rows: kyberRows } = await db.query("SELECT count(*) FROM kyber_signed_prekeys");
checks.push(["a kyber_signed_prekeys row was also created (PQXDH bundle complete)", Number(kyberRows[0].count) === countAfter, `kyber=${kyberRows[0].count} identity=${countAfter}`]);

await page.reload();
await page.click('[data-testid="tab-me"]'); // a returning account lands on its chats
await page.waitForSelector('[data-testid="safety-number"]', { timeout: 15000 });
const safetyNumberAfterReload = await page.textContent('[data-testid="safety-number"]');
checks.push([
  "reload reuses the same identity (same safety number)",
  safetyNumberAfterReload === safetyNumber,
  `before=${safetyNumber} after=${safetyNumberAfterReload}`,
]);

const countAfterReload = await identityKeysCount();
checks.push(["reload does not create another identity_keys row", countAfterReload === countAfter, `after-click=${countAfter} after-reload=${countAfterReload}`]);

checks.push(["still no console errors after reload", consoleErrors.length === 0, consoleErrors.join("; ")]);

let failed = false;
for (const [label, ok, detail] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${ok ? "" : ` (${detail})`}`);
  if (!ok) failed = true;
}

await browser.close();
await db.end();
process.exit(failed ? 1 : 0);
