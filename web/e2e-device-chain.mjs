import { chromium } from "playwright";

// The signed device list against a hostile server. Every scenario puts a route in front of one
// client and changes what the server says: forged statement, substituted prekey-bundle key,
// substituted pending-device key, an addition hidden from a contact, a removal withheld.
// Dev server only (reads source modules like e2e-typing-signal).
const checks = [];
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${ok ? "" : ` (${detail ?? ""})`}`);
  checks.push(ok);
}
const errors = [];
const browser = await chromium.launch();

async function newPage(label) {
  const page = await (await browser.newContext()).newPage();
  page.on("pageerror", (err) => errors.push(`${label}: ${err}`));
  await page.goto("http://localhost:5173");
  return page;
}

async function createAccount(label) {
  const page = await newPage(label);
  await page.click("text=Create Account");
  await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  return { page, id: (await page.textContent('[data-testid="account-id"]')).trim() };
}

// Links a second device to `owner` and accepts it from the owner's page.
async function linkDevice(owner, label) {
  await owner.page.click("text=Link a New Device");
  await owner.page.waitForSelector('[data-testid="link-code"]', { timeout: 15000 });
  const code = (await owner.page.textContent('[data-testid="link-code"]')).trim();
  const page = await newPage(label);
  await page.fill('input[placeholder="Account ID"]', owner.id);
  await page.fill('input[placeholder="Pairing code"]', code);
  await page.click("text=Link This Device");
  await owner.page.waitForSelector('[data-testid="accept-device"]', { timeout: 15000 });
  await owner.page.click('[data-testid="accept-device"]');
  await page.waitForSelector('[data-testid="account-id"]', { timeout: 30000 });
  return { page, id: owner.id };
}

async function openConversation(page, contactId) {
  await page.fill('input[placeholder="Recipient account id"]', contactId);
  await page.click("text=Start Conversation");
  await page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });
}

async function send(page, text) {
  await page.fill('input[placeholder="Type a message..."]', text);
  await page.click("text=Send");
}

const notice = (page, reason) => page.locator(`[data-testid="trust-alert"][data-reason="${reason}"]`);
const received = (page) => page.locator('[data-testid="message-received"]').allTextContents();

// ---- 1. A statement forged by someone who is not in the list ----
{
  const alice = await createAccount("alice");
  const bob = await createAccount("bob");
  await openConversation(bob.page, alice.id);
  await send(bob.page, "real hello");
  await bob.page.waitForSelector('[data-testid="message-sent"]', { timeout: 15000 });
  await openConversation(alice.page, bob.id);
  await alice.page.waitForFunction(() => document.querySelector('[data-testid="message-received"]'), null, { timeout: 15000 });

  const forged = await bob.page.evaluate(async (aliceId) => {
    const dl = await import("/src/crypto/deviceList.ts");
    const id = await import("/src/crypto/identity.ts");
    const chains = await import("/src/crypto/chains.ts");
    const keyStore = await import("/src/storage/keyStore.ts");
    const account = await keyStore.loadAccount();
    const state = await chains.verifiedChain(aliceId, account);
    const attacker = await id.generateIdentity(1);
    const attackerId = crypto.randomUUID();
    const entry = { deviceId: attackerId, identityKey: Uint8Array.from(attacker.identity_public_key) };
    const s = await dl.signStatement({ accountId: aliceId, version: state.version + 1, prevHead: state.head, signerDeviceId: attackerId, devices: [...state.devices, entry] }, attacker.identity_private_key);
    const b64 = (u8) => btoa(String.fromCharCode(...u8));
    return { statement: b64(s.bytes), signature: b64(s.signature), version: state.version + 1 };
  }, alice.id);

  await bob.page.route(`**/v1/accounts/${alice.id}/device-list*`, async (route) => {
    const response = await route.fetch();
    const real = await response.json();
    await route.fulfill({ response, json: [...real, { version: forged.version, statement: forged.statement, signature: forged.signature }] });
  });
  const before = (await received(alice.page)).length;
  await send(bob.page, "must not leave");
  await bob.page.waitForSelector('[role="alert"]', { timeout: 15000 });
  const alert = await bob.page.textContent('[role="alert"]');
  check("a forged statement makes the send fail", alert.toLowerCase().includes("signed device list"), alert);
  await alice.page.waitForTimeout(7000);
  check("and nothing reaches Alice", (await received(alice.page)).length === before, "extra message arrived");
  await alice.page.context().close();
  await bob.page.context().close();
}

// ---- 2. A prekey bundle with a key other than the listed one ----
{
  const dave = await createAccount("dave");
  const bob = await createAccount("bob2");
  const otherKey = await bob.page.evaluate(async () => {
    const id = await import("/src/crypto/identity.ts");
    const b = await id.generateIdentity(1);
    return btoa(String.fromCharCode(...b.identity_public_key));
  });
  await bob.page.route("**/v1/devices/*/prekey-bundle", async (route) => {
    const response = await route.fetch();
    const real = await response.json();
    await route.fulfill({ response, json: { ...real, identity_public_key: otherKey } });
  });
  await openConversation(bob.page, dave.id);
  await send(bob.page, "to a substituted key");
  await bob.page.waitForSelector('[role="alert"]', { timeout: 15000 });
  check("a bundle with another key than the listed one is not used", (await bob.page.textContent('[role="alert"]')).toLowerCase().includes("signed device list"));
  await notice(bob.page, "key-mismatch").first().waitFor({ timeout: 10000 });
  check("and the user is told", true);
  await dave.page.context().close();
  await bob.page.context().close();
}

// ---- 3. A pending device whose key the server swaps on its way to the signer ----
{
  const owner = await createAccount("owner");
  await owner.page.click("text=Link a New Device");
  await owner.page.waitForSelector('[data-testid="link-code"]', { timeout: 15000 });
  const code = (await owner.page.textContent('[data-testid="link-code"]')).trim();
  const attackerKey = await owner.page.evaluate(async () => {
    const id = await import("/src/crypto/identity.ts");
    const b = await id.generateIdentity(1);
    return btoa(String.fromCharCode(...b.identity_public_key));
  });
  await owner.page.route("**/pending-devices", async (route) => {
    const response = await route.fetch();
    const real = await response.json();
    await route.fulfill({ response, json: real.map((d) => ({ ...d, identity_public_key: attackerKey })) });
  });
  const newDevice = await newPage("newdevice");
  await newDevice.fill('input[placeholder="Account ID"]', owner.id);
  await newDevice.fill('input[placeholder="Pairing code"]', code);
  await newDevice.click("text=Link This Device");
  await newDevice.waitForSelector('[data-testid="link-fingerprint"]', { timeout: 15000 });
  await owner.page.waitForSelector('[data-testid="pending-device"]', { timeout: 15000 });
  const onNew = (await newDevice.textContent('[data-testid="link-fingerprint"]')).trim();
  const onOwner = (await owner.page.textContent('[data-testid="pending-fingerprint"]')).trim();
  check("a swapped key shows a different fingerprint than the new device's", onNew !== onOwner, onNew);
  await owner.page.click('[data-testid="accept-device"]');
  await owner.page.waitForSelector('[role="alert"]', { timeout: 15000 });
  check("and accepting it anyway is refused by the server", (await owner.page.textContent('[role="alert"]')).toLowerCase().includes("registered"));
  await newDevice.waitForTimeout(5000);
  check("the new device stays unaccepted", (await newDevice.locator('[data-testid="link-fingerprint"]').count()) === 1);
  await owner.page.context().close();
  await newDevice.context().close();
}

// ---- 4 and 5. Hidden addition, withheld removal ----
{
  const alice1 = await createAccount("alice1");
  const alice2 = await linkDevice(alice1, "alice2");

  // 4. Bob never learns of the second device: its first message comes from an unlisted device.
  const bob2 = await createAccount("bob3");
  await bob2.page.route(`**/v1/accounts/${alice1.id}/device-list*`, async (route) => {
    const response = await route.fetch();
    const real = await response.json();
    await route.fulfill({ response, json: real.filter((s) => s.version <= 1) });
  });
  await openConversation(alice2.page, bob2.id);
  await send(alice2.page, "from the second device");
  await notice(bob2.page, "unlisted-device").first().waitFor({ timeout: 20000 });
  check("a message from a device the server hid from the contact is refused and flagged", true);
  check("and its text is not shown", !(await bob2.page.content()).includes("from the second device"));
  await bob2.page.context().close();

  // 5. Bob knows both devices, then the server withholds the removal of one.
  const bob = await createAccount("bob4");
  await openConversation(bob.page, alice1.id);
  await send(bob.page, "hello both");
  await bob.page.waitForSelector('[data-testid="message-sent"]', { timeout: 15000 });
  await openConversation(alice1.page, bob.id);
  await alice1.page.waitForFunction(() => document.querySelector('[data-testid="message-received"]'), null, { timeout: 15000 });
  check("no notice while the server tells the truth", (await bob.page.locator('[data-testid="trust-alert"]').count()) === 0);

  await bob.page.route(`**/v1/accounts/${alice1.id}/device-list*`, async (route) => {
    const response = await route.fetch();
    const real = await response.json();
    await route.fulfill({ response, json: real.filter((s) => s.version <= 2) });
  });
  // Alice removes her second device (from the first): version 3, which Bob's server will not show.
  await alice1.page.evaluate(async () => {
    const actions = await import("/src/crypto/deviceActions.ts");
    const chains = await import("/src/crypto/chains.ts");
    const keyStore = await import("/src/storage/keyStore.ts");
    const account = await keyStore.loadAccount();
    const state = await chains.verifiedChain(account.accountId, account);
    const other = state.devices.find((d) => d.deviceId !== account.deviceId);
    await actions.removeDevice(account, other.deviceId);
  });
  await send(alice1.page, "after the removal");
  await notice(bob.page, "chain-withheld").first().waitFor({ timeout: 20000 });
  check("a removal the server withholds is exposed by the sender's own next message", true);
  await bob.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="message-received"]')].some((e) => e.textContent.includes("after the removal")), null, { timeout: 20000 });
  check("the message itself is still delivered", true);
  await alice1.page.context().close();
  await alice2.page.context().close();
  await bob.page.context().close();
}

check("no uncaught page error", errors.length === 0, errors.join(" | "));
await browser.close();
process.exit(checks.some((ok) => !ok) ? 1 : 0);
