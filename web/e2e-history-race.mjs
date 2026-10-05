import { chromium } from "playwright";

// Drives the real messageStore module (dev server only, like e2e-typing-signal): many
// concurrent writers on one bucket must all land. The control uses the old unlocked
// load-modify-save and must lose writes, otherwise this test proves nothing.
const checks = [];
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${ok ? "" : ` (${detail ?? ""})`}`);
  checks.push(ok);
}

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto("http://localhost:5173");
await page.click("text=Create Account");
await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });

const result = await page.evaluate(async () => {
  const store = await import("/src/storage/messageStore.ts");
  const msg = (id) => ({ id, direction: "sent", text: id, status: "sent", createdAt: new Date().toISOString() });
  const N = 40;
  const ids = Array.from({ length: N }, (_, i) => `m${i}`);

  await Promise.all(ids.map((id) => store.updateMessages("locked", (h) => void h.push(msg(id)))));
  const locked = await store.loadMessages("locked");

  await Promise.all(
    ids.map(async (id) => {
      const h = await store.loadMessages("unlocked");
      h.push(msg(id));
      await store.saveMessages("unlocked", h);
    }),
  );
  const unlocked = await store.loadMessages("unlocked");

  // A failing change must not wedge the chain.
  await store.updateMessages("locked", () => { throw new Error("boom"); }).catch(() => {});
  const after = await store.updateMessages("locked", (h) => void h.push(msg("after")));

  return { N, locked: new Set(locked.map((m) => m.id)).size, lockedLen: locked.length, unlocked: unlocked.length, after: after.length };
});

check("all concurrent updateMessages writes land", result.locked === result.N && result.lockedLen === result.N, JSON.stringify(result));
check("control: unlocked load-modify-save loses writes", result.unlocked < result.N, JSON.stringify(result));
check("a throwing change does not block the next update", result.after === result.N + 1, JSON.stringify(result));

await browser.close();
process.exit(checks.some((ok) => !ok) ? 1 : 0);
