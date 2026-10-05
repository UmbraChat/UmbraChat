import { chromium } from "playwright";

const checks = [];
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${ok ? "" : ` (${detail ?? ""})`}`);
  checks.push(ok);
}
const text = async (page, selector) => (await page.textContent(selector)).trim();

const browser = await chromium.launch();

// An uncaught error in any page (a decrypt failure aborting a poll, say) fails the run: it
// can lose messages even when every visible check still passes.
const pageErrors = [];
function track(page) {
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  return page;
}

async function createAccount() {
  const page = track(await (await browser.newContext()).newPage());
  await page.goto("http://localhost:5173");
  await page.click("text=Create Account");
  await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  return { page, accountId: await text(page, '[data-testid="account-id"]'), safetyNumber: await text(page, '[data-testid="safety-number"]') };
}

async function open(page, peerId) {
  await page.fill('input[placeholder="Recipient account id"]', peerId);
  await page.click("text=Start Conversation");
  await page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });
}

async function send(page, body) {
  await page.fill('input[placeholder="Type a message..."]', body);
  await page.click("text=Send");
}

const received = (page, body) => page.waitForSelector(`[data-testid="message-received"]:has-text("${body}")`, { timeout: 20000 });

// Links a fresh browser as an extra device of `owner` (which must show the identity screen).
async function linkDevice(owner) {
  const stale = await owner.page.locator('[data-testid="link-code"]').first().textContent({ timeout: 500 }).catch(() => null);
  await owner.page.click("text=Link a New Device");
  await owner.page.waitForFunction((old) => {
    const el = document.querySelector('[data-testid="link-code"]');
    return el && el.textContent.trim() !== old;
  }, stale?.trim() ?? null, { timeout: 15000 });
  const code = await text(owner.page, '[data-testid="link-code"]');
  const page = track(await (await browser.newContext()).newPage());
  await page.goto("http://localhost:5173");
  await page.fill('input[placeholder="Account ID"]', owner.accountId);
  await page.fill('input[placeholder="Pairing code"]', code);
  await page.click("text=Link This Device");
  await owner.page.waitForSelector('[data-testid="accept-device"]', { timeout: 15000 });
  await owner.page.click('[data-testid="accept-device"]');
  await page.waitForSelector('[data-testid="account-id"]', { timeout: 30000 });
  return { page, safetyNumber: await text(page, '[data-testid="safety-number"]') };
}

const alice = await createAccount();
const bob = await createAccount();

// First contact is trusted on first use: no alert, messages flow both ways.
await open(alice.page, bob.accountId);
await open(bob.page, alice.accountId);
await send(alice.page, "hello bob");
await received(bob.page, "hello bob");
await send(bob.page, "hello alice");
await received(alice.page, "hello alice");
check("first contact raises no alert", (await alice.page.locator('[data-testid="trust-alert"]').count()) === 0);

// Both sides see the same pairwise safety number, which is not either device's own key fingerprint.
await alice.page.click("text=Verify this contact");
await bob.page.click("text=Verify this contact");
await alice.page.waitForSelector('[data-testid="contact-fingerprint"]', { timeout: 15000 });
await bob.page.waitForSelector('[data-testid="contact-fingerprint"]', { timeout: 15000 });
const aliceSees = await text(alice.page, '[data-testid="contact-fingerprint"]');
const bobSees = await text(bob.page, '[data-testid="contact-fingerprint"]');
check("both sides see the same safety number", aliceSees === bobSees, `${aliceSees} vs ${bobSees}`);
check("it differs from each device's own key fingerprint", aliceSees !== bob.safetyNumber && aliceSees !== alice.safetyNumber);

// Bob links a second device and accepts it from his first one: it is in his signed device
// list, so Alice needs no manual step to talk to it, and no alert is raised.
await bob.page.click('button[aria-label="Back to menu"]');
const bob2 = await linkDevice(bob);
check("the linked device has its own key", bob2.safetyNumber !== bob.safetyNumber);

await open(bob2.page, alice.accountId);
await send(bob2.page, "from the new device");
await received(alice.page, "from the new device");
check("a device in the signed list is heard without any alert", (await alice.page.locator('[data-testid="trust-alert"]').count()) === 0);

await send(alice.page, "to both devices");
await received(bob2.page, "to both devices");
check("alice reaches the linked device", true);

// Notices persist: a device the server invents is refused, flagged, and still flagged after a reload.
const ghost = await alice.page.evaluate(async (bobId) => {
  const { raiseNotice } = await import("/src/crypto/trust.ts");
  await raiseNotice("unlisted-device", bobId, "00000000-0000-4000-8000-000000000001");
  return true;
}, bob.accountId);
check("a notice can be raised", ghost);
await alice.page.reload();
await alice.page.waitForSelector('[data-testid="trust-alert"]', { timeout: 20000 });
check("it is still there after a reload", (await alice.page.locator('[data-testid="trust-alert"][data-reason="unlisted-device"]').count()) === 1);
check("and it offers no way to accept the device", (await alice.page.locator('text=accept').count()) === 0);
await alice.page.click("text=Dismiss");
check("dismissing clears it", (await alice.page.locator('[data-testid="trust-alert"]').count()) === 0);

// A different key for a device we already hold a session with (a replaced key, or a forged
// sender) cannot be produced through the UI, so this drives the store directly. Dev server only:
// it imports source modules.
const keyChange = await alice.page.evaluate(async () => {
  const { generateIdentity } = await import("/src/crypto/identity.ts");
  const { openStore } = await import("/src/crypto/session.ts");
  const { admitPeer, subscribeToTrustAlerts } = await import("/src/crypto/trust.ts");

  const bundleOf = (id) => ({
    identity_public_key: id.identity_public_key,
    registration_id: id.registration_id,
    signed_prekey: { key_id: id.signed_prekey.key_id, public_key: id.signed_prekey.public_key, signature: id.signed_prekey.signature },
    kyber_signed_prekey: { key_id: id.kyber_signed_prekey.key_id, public_key: id.kyber_signed_prekey.public_key, signature: id.kyber_signed_prekey.signature },
    one_time_prekey: { key_id: id.one_time_prekeys[0].key_id, public_key: id.one_time_prekeys[0].public_key },
  });
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const chainOf = (...devices) => ({ accountId: "bob", version: 1, head: new Uint8Array(32), devices: devices.map(([deviceId, id]) => ({ deviceId, identityKey: Uint8Array.from(id.identity_public_key) })) });

  const [idA, idB1, idB2] = [await generateIdentity(), await generateIdentity(), await generateIdentity()];
  const first = await openStore(idA);
  first.establish_session("bob:d1", bundleOf(idB1));
  const saved = first.export_session("bob:d1");

  // Page reload: the store is rebuilt, the session restored from storage.
  const store = await openStore(idA);
  store.import_session("bob:d1", saved);
  const pinnedAfterReload = hex(store.peer_identity("bob:d1")) === hex(idB1.identity_public_key);

  // Another key now speaks as bob:d1.
  const impostor = await openStore(idB2);
  impostor.establish_session("alice:d1", bundleOf(idA));
  const envelope = impostor.encrypt("alice:d1", new TextEncoder().encode("hi"));

  let rawDecryptRefused = false;
  try {
    store.decrypt("bob:d1", envelope);
  } catch {
    rawDecryptRefused = true;
  }

  let alerts = [];
  subscribeToTrustAlerts((a) => (alerts = a));
  // The list says d1 has idB1's key: the impostor's key is refused, the real one admitted.
  const listed = chainOf(["d1", idB1]);
  const impostorAdmitted = await admitPeer(store, "bob", "d1", "bob:d1", idB2.identity_public_key, listed);
  const mismatchRaised = alerts.some((a) => a.reason === "key-mismatch");
  const realAdmitted = await admitPeer(store, "bob", "d1", "bob:d1", idB1.identity_public_key, listed);
  // A list that (wrongly) lists the impostor's key for a device we pinned to another one: still refused.
  const rewritten = await admitPeer(store, "bob", "d1", "bob:d1", idB2.identity_public_key, chainOf(["d1", idB2]));
  const changedRaised = alerts.some((a) => a.reason === "key-changed");
  const unlisted = await admitPeer(store, "bob", "d9", "bob:d9", idB2.identity_public_key, listed);
  return { pinnedAfterReload, rawDecryptRefused, impostorAdmitted, mismatchRaised, realAdmitted, rewritten, changedRaised, unlisted };
});
check("a restored session re-pins the peer's key", keyChange.pinnedAfterReload);
check("libsignal itself refuses a different key for a pinned device", keyChange.rawDecryptRefused);
check("a key other than the listed one is refused and flagged", !keyChange.impostorAdmitted && keyChange.mismatchRaised);
check("the listed key is admitted", keyChange.realAdmitted);
check("a pinned device cannot be moved to another key even by the list", !keyChange.rewritten && keyChange.changedRaised);
check("a device missing from the list is refused", !keyChange.unlisted);

check("no page raised an uncaught error", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();
process.exit(checks.some((ok) => !ok) ? 1 : 0);
