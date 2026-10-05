import { chromium } from "playwright";
import { startChat } from "./ui-steps.mjs";

// Not covered here: the "failed" (NAT-blocked) end state. Both peers run on
// localhost in this environment, so ICE always finds a direct path - there's
// no way to force a real connection failure without faking NAT behavior the
// test can't reliably control. The code path is the same onconnectionstatechange
// pattern already exercised by the "connected" transition below, just for a
// different value - low risk, out of reach in this environment, not skipped
// silently.

const checks = [];
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${ok ? "" : ` (${detail ?? ""})`}`);
  checks.push(ok);
}

const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});

async function createAccount(context) {
  const page = await context.newPage();
  await page.goto("http://localhost:5173");
  await page.click("button");
  await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  const accountId = (await page.textContent('[data-testid="account-id"]')).trim();
  return { page, accountId };
}

const aliceContext = await browser.newContext();
await aliceContext.grantPermissions(["camera", "microphone"]);
const bobContext = await browser.newContext();
await bobContext.grantPermissions(["camera", "microphone"]);

const alice = await createAccount(aliceContext);
const bob = await createAccount(bobContext);

await startChat(alice.page, bob.accountId);
await alice.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });
await startChat(bob.page, alice.accountId);
await bob.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });

// --- video call: full nominal path ---
// The very first ring notification is bounded by the callee's standing 3s poll
// rate - bob has no way to know to poll faster before he's already seen the
// offer, so this hop can't be sped up by the tightened interval. What the
// tightened interval actually buys is every round trip *after* both sides are
// already ringing (the answer coming back, ICE candidates) - checked below via
// accept-to-connected timing instead.
await alice.page.click('[aria-label="Video call"]');
await bob.page.waitForSelector('[data-testid="incoming-call-banner"]', { timeout: 15000 });

const bannerText = await bob.page.textContent('[data-testid="incoming-call-banner"]');
check("the banner names the call kind", bannerText.includes("video"), bannerText);

const callButtonDisabled = await alice.page.getAttribute('[aria-label="Voice call"]', "disabled");
check("call buttons disable while a call is ringing", callButtonDisabled !== null);

const acceptedAt = Date.now();
await bob.page.click("text=Accept");
await alice.page.waitForSelector('[data-testid="active-call-screen"]', { timeout: 15000 });
await bob.page.waitForSelector('[data-testid="active-call-screen"]', { timeout: 15000 });
await alice.page.waitForFunction(() => document.querySelector('[data-testid="call-status-label"]')?.textContent === "Connected", { timeout: 15000 });
await bob.page.waitForFunction(() => document.querySelector('[data-testid="call-status-label"]')?.textContent === "Connected", { timeout: 15000 });
const connectedElapsedMs = Date.now() - acceptedAt;
check("both sides reach Connected", true);
check(
  "once both sides are ringing, the answer+ICE round trip completes well under the 3s message-poll interval (tightened poll)",
  connectedElapsedMs < 2500,
  `elapsed=${connectedElapsedMs}ms`,
);

const aliceRemoteVideo = await alice.page.locator('[data-testid="remote-video"]').getAttribute("srcObject").catch(() => null);
// srcObject isn't a reflected HTML attribute, so read it as a DOM property instead.
const aliceHasRemoteStream = await alice.page.evaluate(() => document.querySelector('[data-testid="remote-video"]')?.srcObject instanceof MediaStream);
check("alice's remote video element has a live MediaStream attached", aliceHasRemoteStream, aliceRemoteVideo);

await alice.page.click("text=Hang Up");
// Each side's "ended" card closes 3s after it shows, and the other side learns of the hang-up
// at its next poll (up to 3s later): read each reason as soon as it shows.
await alice.page.waitForSelector('[data-testid="call-ended"]', { timeout: 15000 });
const aliceEndReason = await alice.page.textContent('[data-testid="call-end-reason"]');
await bob.page.waitForSelector('[data-testid="call-ended"]', { timeout: 15000 });
const bobEndReason = await bob.page.textContent('[data-testid="call-end-reason"]');
check("alice sees 'Call ended' after hanging up", aliceEndReason === "Call ended", aliceEndReason);
check("bob sees 'Call ended' too", bobEndReason === "Call ended", bobEndReason);

await alice.page.waitForTimeout(3500);
await bob.page.waitForTimeout(500);

// --- voice call: audio only ---
await alice.page.click('[aria-label="Voice call"]');
await bob.page.waitForSelector('[data-testid="incoming-call-banner"]', { timeout: 15000 });
await bob.page.click("text=Accept");
await alice.page.waitForFunction(() => document.querySelector('[data-testid="call-status-label"]')?.textContent === "Connected", { timeout: 15000 });
const aliceHasRemoteVideoEl = await alice.page.locator('[data-testid="remote-video"]').count();
const aliceHasRemoteAudioEl = await alice.page.locator('[data-testid="remote-audio"]').count();
check("a voice call renders no remote <video> element, only <audio>", aliceHasRemoteVideoEl === 0 && aliceHasRemoteAudioEl === 1, `video=${aliceHasRemoteVideoEl} audio=${aliceHasRemoteAudioEl}`);
await alice.page.click("text=Hang Up");
await alice.page.waitForSelector('[data-testid="call-ended"]', { timeout: 15000 });
await alice.page.waitForTimeout(3500);
await bob.page.waitForTimeout(500);

// --- declined ---
await alice.page.click('[aria-label="Voice call"]');
await bob.page.waitForSelector('[data-testid="incoming-call-banner"]', { timeout: 15000 });
await bob.page.click("text=Decline");
await alice.page.waitForSelector('[data-testid="call-ended"]', { timeout: 15000 });
const declineReason = await alice.page.textContent('[data-testid="call-end-reason"]');
check("a declined call shows 'Declined' to the caller", declineReason === "Declined", declineReason);
await alice.page.waitForTimeout(3500);
await bob.page.waitForTimeout(500);

// --- caller cancels before the callee answers ---
await alice.page.click('[aria-label="Voice call"]');
await bob.page.waitForSelector('[data-testid="incoming-call-banner"]', { timeout: 15000 });
await alice.page.click("text=Hang Up");
await alice.page.waitForSelector('[data-testid="call-ended"]', { timeout: 15000 });
const cancelReason = await alice.page.textContent('[data-testid="call-end-reason"]');
check("cancelling an outgoing ring before it's answered shows 'Call cancelled', not 'Call ended'", cancelReason === "Call cancelled", cancelReason);
await alice.page.waitForTimeout(3500);
await bob.page.waitForTimeout(500);

// --- unreachable: no answer within the timeout ---
await alice.page.click('[aria-label="Voice call"]');
await alice.page.waitForSelector('[data-testid="call-end-reason"]', { timeout: 40000 });
const timeoutReason = await alice.page.textContent('[data-testid="call-end-reason"]');
check("a call nobody answers shows 'Unreachable' after the timeout", timeoutReason === "Unreachable", timeoutReason);

await browser.close();

const failed = checks.some((ok) => !ok);
process.exit(failed ? 1 : 0);
