import { chromium } from "playwright";
import { startChat, openTab, contactSettings } from "./ui-steps.mjs";

// A chat started without a message stays in the list; "Delete chat" removes this device's copy only.
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

const rows = (page) => page.locator('[data-testid="chat-row"], [data-testid="incoming-chat-row"]').allTextContents();
const MESSAGE = 'input[placeholder="Type a message..."]';

async function send(page, text) {
  await page.fill(MESSAGE, text);
  await page.click('button[aria-label="Send"]');
}

try {
  const alice = await createAccount("alice");
  const bob = await createAccount("bob");
  const carol = await createAccount("carol");

  // Alice already talks with Carol, then adds Bob without writing to him.
  await startChat(alice.page, carol.id);
  await alice.page.waitForSelector(MESSAGE, { timeout: 15000 });
  await send(alice.page, "hello carol");
  await alice.page.waitForSelector('[data-testid="message-status"]', { timeout: 15000 });
  await startChat(alice.page, bob.id);
  await alice.page.waitForSelector(MESSAGE, { timeout: 15000 });
  await alice.page.click('button[aria-label="Back to menu"]');
  await alice.page.reload();
  await openTab(alice.page, "chats");
  await alice.page.waitForFunction(() => document.querySelectorAll('[data-testid="chat-row"]').length >= 2, null, { timeout: 15000 });
  const list = await rows(alice.page);
  check("a chat started without a message stays in the list after a reload", list.some((t) => t.includes(bob.id) && t.includes("No messages yet")), JSON.stringify(list));
  check("and sits on top, above older chats", list[0]?.includes(bob.id), JSON.stringify(list));

  await bob.page.waitForTimeout(4000); // longer than one poll
  check("adding someone sends them nothing", (await rows(bob.page)).length === 0, JSON.stringify(await rows(bob.page)));

  // Cancel keeps the chat; Delete removes it, on this device only.
  await alice.page.click(`[data-testid="chat-row"]:has-text("${carol.id}")`);
  await alice.page.waitForSelector(MESSAGE, { timeout: 15000 });
  await contactSettings(alice.page);
  await alice.page.click('button.setting:has-text("Delete chat")');
  await alice.page.click('dialog[aria-label="Delete chat"] button:text-is("Cancel")');
  check("Cancel keeps the chat", (await rows(alice.page)).some((t) => t.includes(carol.id)));

  await alice.page.click('button.setting:has-text("Delete chat")');
  await alice.page.click('dialog[aria-label="Delete chat"] button:text-is("Delete chat")');
  await alice.page.waitForFunction((id) => ![...document.querySelectorAll('[data-testid="chat-row"]')].some((r) => r.textContent.includes(id)), carol.id, { timeout: 15000 });
  check("Delete chat leaves the chat and removes it from the list", (await alice.page.locator(MESSAGE).count()) === 0);
  await alice.page.reload();
  await openTab(alice.page, "chats");
  await alice.page.waitForSelector('[data-testid="chat-row"]', { timeout: 15000 });
  check("it stays deleted after a reload", !(await rows(alice.page)).some((t) => t.includes(carol.id)), JSON.stringify(await rows(alice.page)));

  // Carol keeps her copy and can still write: the chat comes back with the new message only.
  await carol.page.click('[data-testid="incoming-chat-row"], [data-testid="chat-row"]').catch(async () => {
    await startChat(carol.page, alice.id);
  });
  await carol.page.waitForSelector(MESSAGE, { timeout: 15000 });
  check("the contact keeps their copy", (await carol.page.locator('[data-testid="message-list"] [data-testid="message-received"]').allTextContents()).some((t) => t.includes("hello carol")));
  await send(carol.page, "still there?");
  await alice.page.waitForSelector(`[data-testid="incoming-chat-row"]:has-text("${carol.id}")`, { timeout: 15000 });
  await alice.page.click(`[data-testid="incoming-chat-row"]:has-text("${carol.id}")`);
  await alice.page.waitForSelector('[data-testid="message-list"] [data-testid="message-received"]', { timeout: 15000 });
  const texts = await alice.page.locator('[data-testid="message-list"] li').allTextContents();
  check("a later message from the contact still decrypts and starts a fresh chat", texts.some((t) => t.includes("still there?")) && !texts.some((t) => t.includes("hello carol")), JSON.stringify(texts));
} catch (err) {
  check("the run reached its end", false, String(err).split("\n")[0]);
}

check("no uncaught page error", errors.length === 0, errors.join(" | "));
await browser.close();
process.exit(checks.some((ok) => !ok) ? 1 : 0);
