import { PROTOCOL_HEADER, PROTOCOL_VERSION, assertSameProtocol } from "./protocol";

// Which server this client talks to. By default the API is same-origin (the compose stack
// serves the app and the API from one host; Vite's dev proxy does the same). A client that
// is not tied to one server (built with VITE_REQUIRE_SERVER_URL=1, installed locally or
// published once for everybody) has no such default: the user enters the server, and a
// copy of the app served by a host then never has to be trusted with the keys.
const STORAGE_KEY = "umbrachat-server-url";
const BUILD_DEFAULT: string = import.meta.env.VITE_API_BASE ?? "";

export const SERVER_URL_REQUIRED = import.meta.env.VITE_REQUIRE_SERVER_URL === "1";

/**
 * Where this copy of the app comes from. One release archive serves both as the locally
 * installed app and as a page published for everybody: only the host serving it tells them apart.
 * - "instance": built for one server and served by it (same origin).
 * - "local": the generic build, served from this device.
 * - "hosted": the generic build, served by someone else's host (a published page).
 */
export const DISTRIBUTION: "instance" | "local" | "hosted" = !SERVER_URL_REQUIRED
  ? "instance"
  : ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)
    ? "local"
    : "hosted";

function readStored(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

/** The server chosen by the user on this device, or "" if none (same origin / build default). */
export function getStoredServerUrl(): string {
  return readStored();
}

/** Base URL prepended to every API path: "" means same origin. An instance's build ignores any stored choice. */
export function getServerUrl(): string {
  return SERVER_URL_REQUIRED ? readStored() : BUILD_DEFAULT;
}

export function apiUrl(path: string): string {
  const base = getServerUrl();
  // Without this a not-yet-configured generic client would send API calls to its own host.
  if (SERVER_URL_REQUIRED && !base) throw new Error("choose a server first");
  return `${base}${path}`;
}

let verified: Promise<void> | undefined;
let verifiedFor = "";

// A server that does not enforce the version could answer a request with the right data and
// still be the wrong version, and fetching messages deletes them server-side. So before the
// first real request to a server, one harmless public request checks its version.
function ensureServerVersion(): Promise<void> {
  const base = getServerUrl();
  if (verified && verifiedFor === base) return verified;
  verifiedFor = base;
  verified = fetch(apiUrl("/v1/push-key"), { headers: { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) } }).then(assertSameProtocol);
  verified.catch(() => {
    verified = undefined;
  });
  return verified;
}

/**
 * Every request to the API goes through here: it declares this app's protocol version and
 * refuses (and blocks the app on) a server that does not answer with exactly the same one.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  await ensureServerVersion();
  const response = await fetch(apiUrl(path), { ...init, headers: { ...init.headers, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) } });
  assertSameProtocol(response);
  return response;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Reduces user input to an origin, or throws a message fit for the user. */
export function normalizeServerUrl(input: string): string {
  const text = input.trim();
  if (!text) throw new Error("enter a server address");
  let url: URL;
  try {
    url = new URL(text.includes("://") ? text : `https://${text}`);
  } catch {
    throw new Error("that is not a valid server address");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("the server address must start with https://");
  if (url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname)) throw new Error("use https:// - plain http is only allowed for localhost");
  if (url.username || url.password) throw new Error("the server address must not contain a user name or password");
  return url.origin;
}

export function setServerUrl(input: string): void {
  const origin = normalizeServerUrl(input);
  try {
    localStorage.setItem(STORAGE_KEY, origin);
  } catch {
    throw new Error("this browser refused to remember the server address");
  }
}

/** The origin of the server this app talks to, also when that is its own. */
export function currentServerOrigin(): string {
  return getServerUrl() || window.location.origin;
}

/** True when the app and the API come from the same host, which can then change the app's code. */
export function isSameHostAsServer(): boolean {
  const base = getServerUrl();
  return base === "" || base === window.location.origin;
}
