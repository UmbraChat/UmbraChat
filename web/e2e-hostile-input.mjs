import { chromium } from "playwright";
import { startChat } from "./ui-steps.mjs";

// What a hostile server (junk injected into the fetched batch) or a hostile contact (crafted
// envelopes) can do to a client. Fetch is fetch-and-delete, so one throw while handling a batch
// used to lose every other message in it. Crafted sends use the real conversation.ts module in
// the page (dev server only, like e2e-typing-signal).
const checks = [];
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${ok ? "" : ` (${detail ?? ""})`}`);
  checks.push(ok);
}

const browser = await chromium.launch();
const errors = [];

async function createAccount(context, label) {
  const page = await context.newPage();
  page.on("pageerror", (err) => errors.push(`${label}: ${err}`));
  await page.goto("http://localhost:5173");
  await page.click("button");
  await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  const accountId = (await page.textContent('[data-testid="account-id"]')).trim();
  return { page, accountId };
}

const alice = await createAccount(await browser.newContext(), "alice");
const bob = await createAccount(await browser.newContext(), "bob");

// A real first message, so Alice and Bob share a session.
await startChat(alice.page, bob.accountId);
await alice.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });
await alice.page.fill('input[placeholder="Type a message..."]', "first");
await alice.page.click('button[aria-label="Send"]');
await alice.page.waitForSelector('[data-testid="message-sent"]', { timeout: 15000 });

const aliceDeviceId = await alice.page.evaluate(async () => (await (await import("/src/storage/keyStore.ts")).loadAccount()).deviceId);
const uuid = "11111111-2222-3333-4444-555555555555";

// Every batch Bob fetches gets junk in front of the real messages.
await bob.page.route("**/v1/messages", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const response = await route.fetch();
  const real = await response.json();
  const junk = [
    { sender_account_id: alice.accountId, sender_device_id: aliceDeviceId, ciphertext: btoa("garbage that is not a signal message at all"), created_at: "now" },
    { sender_account_id: "bob:x", sender_device_id: "../..", ciphertext: "AAAA", created_at: "x" },
    { sender_account_id: uuid, sender_device_id: uuid, ciphertext: "!!!not base64!!!", created_at: "x" },
    null,
    { sender_account_id: uuid, sender_device_id: uuid, ciphertext: btoa("unknown sender"), created_at: 7 },
  ];
  await route.fulfill({ response, json: [...junk, ...real] });
});

await startChat(bob.page, alice.accountId);
await bob.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });
await bob.page.waitForSelector('[data-testid="message-received"]', { timeout: 15000 });
check("a real message gets through a batch full of junk", (await bob.page.textContent('[data-testid="message-received"]')).includes("first"));

// Crafted envelopes from a contact, then a normal message that must still arrive.
await alice.page.evaluate(async (bobId) => {
  const conversation = await import("/src/chat/conversation.ts");
  const keyStore = await import("/src/storage/keyStore.ts");
  const account = await keyStore.loadAccount();
  const store = await conversation.startConversation(bobId, account);
  const send = (e) => conversation.sendToContact(bobId, new TextEncoder().encode(typeof e === "string" ? e : JSON.stringify(e)), account, store);
  await send("this is not json");
  await send({ type: "text", id: "t1", body: 12345 });
  await send({ type: "text", body: "no id" });
  await send({ type: "nonsense" });
  await send({ type: "file", id: "f1", filename: "bad64", mimeType: "text/plain", size: 3, data: "!!!not base64!!!" });
  await send({ type: "file", id: "f2", filename: "huge-timer", mimeType: "text/plain", size: 3, data: "AAAA", timerSeconds: 1e308 });
  await send({ type: "timer", seconds: 1e308 });
  await send({ type: "read" });
  await send({ type: "group-invite", groupId: "g", name: "x", memberAccountIds: "not an array" });
  await send({ type: "file", id: "f3", filename: "evil.html", mimeType: "text/html", size: 4, data: btoa("<b>hi</b>") });
  await send({ type: "text", id: "ok1", body: "survived" });
}, bob.accountId);

await bob.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="message-received"]')].some((e) => e.textContent.includes("survived")), null, { timeout: 30000 });
check("a normal message after crafted ones still arrives", true);

const fileTexts = await bob.page.locator('[data-testid="file-message"]').allTextContents();
check("only the valid file shows up", fileTexts.length === 1 && fileTexts[0].includes("evil.html"), JSON.stringify(fileTexts));
const received = await bob.page.locator('[data-testid="message-received"]').allTextContents();
check("no message with a wrong-typed body", !received.some((t) => t.includes("12345") || t.includes("no id")), JSON.stringify(received));

const blobType = await bob.page.evaluate(async () => {
  const href = document.querySelector('[data-testid="file-download"]').href;
  return (await (await fetch(href)).blob()).type;
});
check("a sender-chosen text/html type is not kept on the blob", blobType === "application/octet-stream", blobType);

check("no uncaught page error", errors.length === 0, errors.join(" | "));

await browser.close();
process.exit(checks.some((ok) => !ok) ? 1 : 0);
