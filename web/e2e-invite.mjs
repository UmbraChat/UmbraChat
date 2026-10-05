import { chromium } from "playwright";

// Contact invite: authenticates the first contact against a server that shows another chain.
// Dev server only (builds a forged chain through source modules, like e2e-device-chain).
const checks = [];
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${ok ? "" : ` (${detail ?? ""})`}`);
  checks.push(ok);
}
const errors = [];
const browser = await chromium.launch();

async function createAccount(label) {
  const page = await (await browser.newContext()).newPage();
  page.on("pageerror", (err) => errors.push(`${label}: ${err}`));
  await page.goto("http://localhost:5173");
  await page.click("text=Create Account");
  await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  return { page, id: (await page.textContent('[data-testid="account-id"]')).trim() };
}

async function start(page, text) {
  await page.fill('input[placeholder="Recipient account id"]', text);
  await page.click("text=Start Conversation");
}

const alice = await createAccount("alice");
await alice.page.click("text=Show my invite");
await alice.page.waitForSelector('[data-testid="invite"]', { timeout: 15000 });
const invite = (await alice.page.textContent('[data-testid="invite"]')).trim();
check("an invite is account id plus the head of the first list", /^umbra:[0-9a-f-]{36}\.[0-9a-f]{64}$/.test(invite) && invite.includes(alice.id), invite);

// A wrong invite (one digit changed) is refused and opens nothing.
{
  const bob = await createAccount("bob-wrong");
  const flipped = invite.slice(0, -1) + (invite.endsWith("0") ? "1" : "0");
  await start(bob.page, flipped);
  await bob.page.waitForSelector('[role="alert"]', { timeout: 15000 });
  check("a wrong invite is refused with an explanation", (await bob.page.textContent('[role="alert"]')).includes("does not match"));
  check("and no conversation opens", (await bob.page.locator('input[placeholder="Type a message..."]').count()) === 0);
  await bob.page.context().close();
}

// A server that shows another chain (self-signed genesis by an attacker, for Alice's id): the invite refuses it.
{
  const bob = await createAccount("bob-forged");
  const forged = await bob.page.evaluate(async (aliceId) => {
    const dl = await import("/src/crypto/deviceList.ts");
    const id = await import("/src/crypto/identity.ts");
    const attacker = await id.generateIdentity(1);
    const deviceId = crypto.randomUUID();
    const entry = { deviceId, identityKey: Uint8Array.from(attacker.identity_public_key) };
    const s = await dl.signStatement(dl.genesisStatement(aliceId, entry), attacker.identity_private_key);
    const b64 = (u8) => btoa(String.fromCharCode(...u8));
    return { version: 1, statement: b64(s.bytes), signature: b64(s.signature) };
  }, alice.id);
  await bob.page.route(`**/v1/accounts/${alice.id}/device-list*`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: [forged] });
  });
  await start(bob.page, invite);
  await bob.page.waitForSelector('[role="alert"]', { timeout: 15000 });
  check("a forged chain for that account is refused when an invite is used", (await bob.page.textContent('[role="alert"]')).includes("does not match"));
  const pinned = await bob.page.evaluate(async (aliceId) => !!(await (await import("/src/crypto/chains.ts")).pinnedChain(aliceId)), alice.id);
  check("and nothing is pinned", !pinned);
  await bob.page.context().close();
}

// The real invite opens the conversation, and messages flow both ways.
{
  const bob = await createAccount("bob");
  await start(bob.page, invite);
  await bob.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 20000 });
  check("the right invite opens the conversation", true);
  await bob.page.fill('input[placeholder="Type a message..."]', "hello with an invite");
  await bob.page.click("text=Send");
  await bob.page.waitForSelector('[data-testid="message-sent"]', { timeout: 15000 });
  await start(alice.page, bob.id);
  await alice.page.waitForSelector('[data-testid="message-received"]:has-text("hello with an invite")', { timeout: 20000 });
  check("a message sent after an invite is delivered", true);

  // Already pinned (trust on first use or earlier invite): the same invite still works, a wrong one still fails.
  await bob.page.click('button[aria-label="Back to menu"]');
  await start(bob.page, invite);
  await bob.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 20000 });
  check("the invite is accepted again for an account already pinned", true);
  await bob.page.context().close();
}

// Your own invite is not a contact.
await alice.page.click('button[aria-label="Back to menu"]').catch(() => {});
await start(alice.page, invite);
await alice.page.waitForSelector('[role="alert"]', { timeout: 15000 });
check("your own invite is refused", (await alice.page.textContent('[role="alert"]')).includes("your own account"));

check("no uncaught page error", errors.length === 0, errors.join(" | "));
await browser.close();
process.exit(checks.some((ok) => !ok) ? 1 : 0);
