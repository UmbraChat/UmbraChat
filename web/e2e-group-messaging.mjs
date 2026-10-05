import { chromium } from "playwright";

const checks = [];
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${ok ? "" : ` (${detail ?? ""})`}`);
  checks.push(ok);
}

const browser = await chromium.launch();

async function newPage() {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("http://localhost:5173");
  return page;
}

async function createAccount(page) {
  await page.click("text=Create Account");
  await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  return (await page.textContent('[data-testid="account-id"]')).trim();
}

const alice = { page: await newPage() };
const bob = { page: await newPage() };
const carol = { page: await newPage() };

alice.accountId = await createAccount(alice.page);
bob.accountId = await createAccount(bob.page);
carol.accountId = await createAccount(carol.page);

// Alice creates a group with Bob and Carol, through the real UI.
await alice.page.fill('input[placeholder="Group name"]', "Book Club");
await alice.page.fill('input[placeholder="Member account IDs, comma-separated"]', `${bob.accountId}, ${carol.accountId}`);
await alice.page.click("text=Create Group");
await alice.page.waitForFunction(() => document.querySelectorAll('[data-testid="group-row"]').length === 1, { timeout: 15000 });
check("the group appears in alice's own list immediately, before any fan-out completes", true);

// Bob and Carol discover the invite just by sitting on the identity-ready
// screen - the fix from this phase's "known limitation" correction.
await bob.page.waitForFunction(() => document.querySelectorAll('[data-testid="group-row"]').length === 1, { timeout: 15000 });
check("bob discovers the group invite while idle on the identity-ready screen", true);
await carol.page.waitForFunction(() => document.querySelectorAll('[data-testid="group-row"]').length === 1, { timeout: 15000 });
check("carol discovers the group invite too", true);

// All three open the group.
await alice.page.click("text=Open");
await alice.page.waitForSelector("h1:has-text('Book Club')", { timeout: 15000 });
await bob.page.click("text=Open");
await bob.page.waitForSelector("h1:has-text('Book Club')", { timeout: 15000 });
await carol.page.click("text=Open");
await carol.page.waitForSelector("h1:has-text('Book Club')", { timeout: 15000 });

const aliceMemberCount = await alice.page.locator('[data-testid="group-member"]').count();
check("alice's member list has all three members", aliceMemberCount === 3, `count=${aliceMemberCount}`);

// Bob sends a message; alice and carol should both see it, attributed to bob.
await bob.page.fill('input[placeholder="Type a message..."]', "hello everyone");
await bob.page.click("text=Send");

await alice.page.waitForSelector(`text=${bob.accountId}: hello everyone`, { timeout: 15000 });
check("alice receives bob's group message, attributed to bob", true);
await carol.page.waitForSelector(`text=${bob.accountId}: hello everyone`, { timeout: 15000 });
check("carol receives it too", true);

// Alice removes carol.
const carolRow = alice.page.locator('[data-testid="group-member"]', { hasText: carol.accountId });
await carolRow.locator("text=Remove").click();
await alice.page.waitForFunction(() => document.querySelectorAll('[data-testid="group-member"]').length === 2, { timeout: 15000 });
check("carol is removed from alice's member list", true);

// Wait for bob's own roster to reflect the removal (his poller runs on its own
// 3s cycle) before he sends - otherwise he'd fan out using his stale roster,
// which would still include carol and not actually test the removal.
await bob.page.waitForFunction(() => document.querySelectorAll('[data-testid="group-member"]').length === 2, { timeout: 15000 });
check("bob's own roster also updates to exclude carol before he sends again", true);

// Bob sends another message - only alice (remaining) should get it.
await bob.page.fill('input[placeholder="Type a message..."]', "carol left");
await bob.page.click("text=Send");
await alice.page.waitForSelector("text=carol left", { timeout: 15000 });
check("alice (remaining member) receives the post-removal message", true);

await alice.page.waitForTimeout(3500); // one more poll tick for carol, to be sure nothing arrives
const carolHasNewMessage = await carol.page.locator("text=carol left").count();
check("carol (removed) never receives the post-removal message", carolHasNewMessage === 0, `count=${carolHasNewMessage}`);

// A removed member cannot put herself back with an "invite" for the same group (it would replace
// the roster without the membership check an update gets).
const groupId = await carol.page.evaluate(async () => (await (await import("/src/storage/groupStore.ts")).loadAllGroups())[0].id);
await carol.page.evaluate(
  async ({ groupId, members }) => {
    const account = await (await import("/src/storage/keyStore.ts")).loadAccount();
    const store = await (await import("/src/crypto/session.ts")).openStore(account.identity);
    const { sendToContact } = await import("/src/chat/conversation.ts");
    const invite = new TextEncoder().encode(JSON.stringify({ type: "group-invite", groupId, name: "Book Club", memberAccountIds: members }));
    for (const id of members.filter((m) => m !== account.accountId)) await sendToContact(id, invite, account, store);
  },
  { groupId, members: [alice.accountId, bob.accountId, carol.accountId] },
);
await alice.page.waitForTimeout(4500); // more than one poll tick on both sides
const rosters = [await alice.page.locator('[data-testid="group-member"]').count(), await bob.page.locator('[data-testid="group-member"]').count()];
check("a removed member's invite for the same group does not put her back", rosters.join() === "2,2", `alice,bob=${rosters}`);

await browser.close();

const failed = checks.some((ok) => !ok);
process.exit(failed ? 1 : 0);
