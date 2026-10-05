import { chromium } from "playwright";
import { startChat, openTab } from "./ui-steps.mjs";

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

async function openConversationWith(page, recipientAccountId) {
  await startChat(page, recipientAccountId);
  await page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });
}

const alice = await createAccount(await browser.newContext());
const bob = await createAccount(await browser.newContext());

// --- Pref defaults off and round-trips ---
await openTab(alice.page, "settings");
await alice.page.waitForSelector('[data-testid="typing-indicator-status"]', { timeout: 15000 });
const statusBefore = await alice.page.textContent('[data-testid="typing-indicator-status"]');
check("typing indicator defaults to Off", statusBefore.trim() === "Off", statusBefore);

await openConversationWith(alice.page, bob.accountId);
await openConversationWith(bob.page, alice.accountId);

// --- With the sender's pref off, composing never sends a typing signal ---
await alice.page.fill('input[placeholder="Type a message..."]', "typing with the pref off");
await bob.page.waitForTimeout(5000); // longer than one poll interval
const bobTypingWhileOff = await bob.page.locator('[data-testid="typing-indicator"]').count();
check("with the sender's pref off, the recipient never sees a typing indicator", bobTypingWhileOff === 0, bobTypingWhileOff);
await alice.page.fill('input[placeholder="Type a message..."]', "");

// --- Enable the pref, then composing does surface it to the recipient ---
await alice.page.click('button[aria-label="Back to menu"]');
await openTab(alice.page, "settings");
await alice.page.waitForSelector('[data-testid="typing-indicator-status"]', { timeout: 15000 });
await alice.page.click('section:has(h2:text("Typing Indicator")) button:has-text("Enable")');
await alice.page.waitForFunction(
  () => document.querySelector('[data-testid="typing-indicator-status"]')?.textContent?.trim() === "On",
  { timeout: 5000 },
);
check("toggling the Settings panel updates its own status label immediately", true);

await openConversationWith(alice.page, bob.accountId);

await alice.page.fill('input[placeholder="Type a message..."]', "h");
await bob.page.waitForSelector('[data-testid="typing-indicator"]', { timeout: 8000 });
const typingText = await bob.page.textContent('[data-testid="typing-indicator"]');
check("with the pref on, the recipient sees the sender's typing indicator", typingText.includes("typing"), typingText);

// --- It clears again after the sender stops (idle timeout), never as a chat message ---
await bob.page.waitForSelector('[data-testid="typing-indicator"]', { state: "detached", timeout: 12000 });
check("the typing indicator clears again after the sender stops composing", true);

const bobMessages = await bob.page.locator('[data-testid="message-received"]').allTextContents();
check("a typing ping never shows up as a chat message", !bobMessages.some((t) => t.includes("h")), JSON.stringify(bobMessages));

console.log(checks.every(Boolean) ? "\nAll checks passed." : "\nSome checks FAILED.");
await browser.close();
process.exit(checks.every(Boolean) ? 0 : 1);
