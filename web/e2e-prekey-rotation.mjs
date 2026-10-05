import { chromium } from "playwright";

// Signed prekey rotation (crypto/prekeyRotation.ts): an aged pair is replaced, first messages
// built against a replaced pair still decrypt (after a reload and in the same page), old pairs
// are forgotten after the retention period, and a failed or refused upload never loses a key the
// server may serve. Dev server only (drives the rotation through source modules).
const checks = [];
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${ok ? "" : ` (${detail ?? ""})`}`);
  checks.push(ok);
}
const errors = [];
const browser = await chromium.launch();
const DAY = 24 * 60 * 60 * 1000;

async function openApp(context, label) {
  const page = await context.newPage();
  page.on("pageerror", (err) => errors.push(`${label}: ${err}`));
  await page.goto("http://localhost:5173");
  return page;
}

async function createAccount(label) {
  const context = await browser.newContext();
  const page = await openApp(context, label);
  await page.click("text=Create Account");
  await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  return { context, page, id: (await page.textContent('[data-testid="account-id"]')).trim() };
}

async function start(page, text) {
  await page.fill('input[placeholder="Recipient account id"]', text);
  await page.click("text=Start Conversation");
}

async function send(page, text) {
  await page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 20000 });
  await page.fill('input[placeholder="Type a message..."]', text);
  await page.click("text=Send");
  await page.waitForSelector(`[data-testid="message-sent"]:has-text("${text}")`, { timeout: 15000 });
}

/** The prekey state of the account stored in `page`'s browser. */
function prekeys(page) {
  return page.evaluate(async () => {
    const account = await (await import("/src/storage/keyStore.ts")).loadAccount();
    const id = account.identity;
    return {
      deviceId: account.deviceId,
      current: id.signed_prekey.key_id,
      currentKyber: id.kyber_signed_prekey.key_id,
      createdAt: id.prekeys_created_at ?? null,
      pending: id.pending_prekeys?.signed_prekey.key_id ?? null,
      retired: (id.retired_prekeys ?? []).map((p) => p.signed_prekey.key_id),
    };
  });
}

/** Rewrites the stored account: `createdAt` for the served pair, `retiredAt` for one retired pair. */
function age(page, { createdAt, retiredAt }) {
  return page.evaluate(
    async ({ createdAt, retiredAt }) => {
      const store = await import("/src/storage/keyStore.ts");
      const account = await store.loadAccount();
      if (createdAt !== undefined) account.identity.prekeys_created_at = createdAt;
      for (const pair of account.identity.retired_prekeys ?? []) if (retiredAt && pair.signed_prekey.key_id === retiredAt.keyId) pair.retired_at = retiredAt.at;
      await store.saveAccount(account);
    },
    { createdAt, retiredAt },
  );
}

function rotateNow(page) {
  return page.evaluate(async () => {
    try {
      await (await import("/src/crypto/prekeyRotation.ts")).rotateSignedPrekeysIfDue();
      return "ok";
    } catch (err) {
      return `threw: ${err}`;
    }
  });
}

/** The signed prekey ids the server hands out for `deviceId`, asked from `page`'s account. */
function served(page, deviceId) {
  return page.evaluate(async (deviceId) => {
    const account = await (await import("/src/storage/keyStore.ts")).loadAccount();
    const bundle = await (await import("/src/api/prekeyBundle.ts")).fetchPrekeyBundle(deviceId, account);
    return [bundle.signed_prekey.key_id, bundle.kyber_signed_prekey.key_id];
  }, deviceId);
}

async function waitFor(condition, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

const bob = await createAccount("bob");
await bob.page.waitForTimeout(1500);
const fresh = await prekeys(bob.page);
check("a new account starts with one fresh pair and does not rotate it", fresh.current === 1 && fresh.pending === null && fresh.retired.length === 0 && Date.now() - fresh.createdAt < 60000, JSON.stringify(fresh));

// A first message built against pair 1 waits in the queue while Bob's pair gets replaced.
await age(bob.page, { createdAt: Date.now() - 8 * DAY });
await bob.page.close();
const alice = await createAccount("alice");
await start(alice.page, bob.id);
await send(alice.page, "built on the old prekey");

{
  const page = await bob.context.newPage();
  page.on("pageerror", (err) => errors.push(`bob-p1: ${err}`));
  // Hold Bob's message fetch: the message must not be read before the pair is replaced.
  await page.route("**/v1/messages", (route) => (route.request().method() === "GET" ? new Promise(() => {}) : route.continue()));
  await page.goto("http://localhost:5173");
  const rotated = await waitFor(async () => (await prekeys(page)).current === 2);
  const state = await prekeys(page);
  check("an aged pair is replaced on the next start", rotated && state.currentKyber === 2 && state.pending === null && state.retired.join() === "1", JSON.stringify(state));
  check("the server hands out the new pair", (await served(alice.page, fresh.deviceId)).join() === "2,2");
  await page.close();
}

const bobPage = await openApp(bob.context, "bob-p2");
await bobPage.waitForSelector("text=Start Conversation", { timeout: 15000 });
await start(bobPage, alice.id);
const oldDelivered = await bobPage
  .waitForSelector('[data-testid="message-received"]:has-text("built on the old prekey")', { timeout: 20000 })
  .then(() => true)
  .catch(() => false);
check("a first message built against the replaced pair still decrypts after a reload", oldDelivered);

// Rotation inside a running page: the new pair has to be usable before any reload.
await age(bobPage, { createdAt: Date.now() - 8 * DAY });
check("a rotation in a running page succeeds", (await rotateNow(bobPage)) === "ok");
check("and the server hands out pair 3", (await served(alice.page, fresh.deviceId)).join() === "3,3");
const carol = await createAccount("carol");
await start(carol.page, bob.id);
await send(carol.page, "first message on the new prekey");
await bobPage.click('button[aria-label="Back to menu"]');
await start(bobPage, carol.id);
const newDelivered = await bobPage
  .waitForSelector('[data-testid="message-received"]:has-text("first message on the new prekey")', { timeout: 20000 })
  .then(() => true)
  .catch(() => false);
check("a first message built against a pair made in this page decrypts without a reload", newDelivered);

// Retention: a pair retired more than 30 days ago is forgotten, a recent one is kept.
await age(bobPage, { retiredAt: { keyId: 1, at: Date.now() - 31 * DAY } });
await rotateNow(bobPage);
const cleaned = await prekeys(bobPage);
check("a pair retired 31 days ago is forgotten, the one retired today is kept", cleaned.retired.join() === "2" && cleaned.current === 3, JSON.stringify(cleaned));

// An upload that does not reach the server keeps the new pair and sends it again later.
await bobPage.route("**/v1/devices/*/signed-prekeys", (route) => route.abort());
await age(bobPage, { createdAt: Date.now() - 8 * DAY });
const failed = await rotateNow(bobPage);
const afterFailure = await prekeys(bobPage);
check("an upload that fails leaves the new pair pending and the served one in place", failed.startsWith("threw") && afterFailure.pending === 4 && afterFailure.current === 3, `${failed} ${JSON.stringify(afterFailure)}`);
check("while the server still hands out pair 3", (await served(alice.page, fresh.deviceId)).join() === "3,3");
await bobPage.unroute("**/v1/devices/*/signed-prekeys");
await rotateNow(bobPage);
const retried = await prekeys(bobPage);
check("the pending pair is sent again and takes over", retried.current === 4 && retried.pending === null && retried.retired.join() === "2,3", JSON.stringify(retried));
check("and the server hands out pair 4", (await served(alice.page, fresh.deviceId)).join() === "4,4");

// A pair the server refuses is dropped: it will never be handed out.
await bobPage.route("**/v1/devices/*/signed-prekeys", (route) =>
  route.fulfill({ status: 400, headers: { "x-umbra-protocol": "2", "content-type": "application/json" }, body: JSON.stringify({ error: "refused" }) }),
);
await age(bobPage, { createdAt: Date.now() - 8 * DAY });
const refusedRun = await rotateNow(bobPage);
const refused = await prekeys(bobPage);
check("a refused pair is dropped and the served pair stays", refusedRun === "ok" && refused.pending === null && refused.current === 4, `${refusedRun} ${JSON.stringify(refused)}`);
await bobPage.unroute("**/v1/devices/*/signed-prekeys");

check("no uncaught page error", errors.length === 0, errors.join(" | "));
await browser.close();
process.exit(checks.some((ok) => !ok) ? 1 : 0);
