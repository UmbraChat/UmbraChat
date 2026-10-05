// Steps through the app's navigation, shared by the e2e-*.mjs scripts (this file is not one of them).

/** Opens one of the bottom tabs: "chats", "me" or "settings". Leaves any open chat. */
export async function openTab(page, tab) {
  await page.click(`[data-testid="tab-${tab}"]`);
}

/** Starts a chat from an account id or an invite. Does not wait for it: it may be refused. */
export async function startChat(page, idOrInvite) {
  // The sheet stays open after a refusal; the list behind it is inert then.
  if (!(await page.locator('dialog[aria-label="New chat"][open]').count())) {
    if (!(await page.isVisible('[data-testid="new-chat"]'))) await openTab(page, "chats");
    await page.click('[data-testid="new-chat"]');
  }
  await page.fill('input[aria-label="Invite or account id"]', idOrInvite);
  await page.click('button:has-text("Start chat")');
}

/** Creates a group from the Chats tab. */
export async function createGroup(page, name, memberIds) {
  if (!(await page.isVisible('[data-testid="new-chat"]'))) await openTab(page, "chats");
  await page.click('[data-testid="new-chat"]');
  await page.click('[role="tab"]:has-text("New group")');
  await page.fill('input[placeholder="Group name"]', name);
  await page.fill('input[placeholder="Member account IDs, comma-separated"]', memberIds.join(","));
  await page.click('button:has-text("Create Group")');
}

/** Opens the open chat's settings (nickname, timer, safety number). */
export async function contactSettings(page) {
  await page.click('button[aria-label="Contact settings"]');
}

/** Opens a folded section of the start page ("Already have an account?", "Lost your device?"). */
export async function unfold(page, title) {
  const section = page.locator("details", { hasText: title });
  if ((await section.getAttribute("open")) === null) await section.locator("summary").click();
}
