// src/lib/ei-host.ts — PURE host-override validation (no server-only import).
//
// Split out of ei-server.ts so the security-critical allowlist logic is unit
// testable without pulling in the `server-only` guard. studioHost/ingestionHost
// overrides are attacker-controllable (URL params, inherited iframe params) and
// every Studio/Ingestion call attaches the secret x-api-key header, so an
// unvalidated host would allow API-key exfiltration / SSRF. Only https URLs whose
// hostname is on the allowlist (and is not a private/loopback address) are
// accepted; path is kept (it only selects the API base) but query/hash dropped.

/**
 * Hostnames that are always allowed (the Edge Impulse cloud). A host is accepted
 * when it equals one of these or is a subdomain of one.
 */
export const ALLOWED_HOST_SUFFIXES = ["edgeimpulse.com"] as const;

/** True for private/loopback/link-local hostnames that must never be reached. */
export function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "0.0.0.0" || h === "::" || h === "[::]" || h === "::1" || h === "[::1]")
    return true;
  // IPv4 literal ranges: loopback (127.), private (10., 192.168., 172.16-31.),
  // link-local (169.254.), and the 0.0.0.0/8 block.
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}

/** True when `hostname` equals or is a subdomain of an allowed host. */
export function isAllowedHostname(hostname: string, extraAllowed: string[] = []): boolean {
  const h = hostname.toLowerCase();
  const allowed = [...ALLOWED_HOST_SUFFIXES, ...extraAllowed];
  return allowed.some((base) => h === base || h.endsWith(`.${base}`));
}

/**
 * Normalize + VALIDATE a host override. Returns undefined (so callers fall back
 * to the safe default) for any host that is not an https URL whose hostname is
 * on the allowlist and is not a private/loopback address. Keeps scheme + host
 * (+ explicit port) + path; drops query/hash and any trailing slash.
 *
 * @param host         the raw override string
 * @param extraAllowed extra allowed bare hostnames (self-hosted EI), trusted
 */
export function normalizeAllowedHost(
  host: string | undefined | null,
  extraAllowed: string[] = [],
): string | undefined {
  if (!host) return undefined;
  const trimmed = host.trim();
  if (!trimmed) return undefined;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }

  if (url.protocol !== "https:") return undefined;
  if (isPrivateHostname(url.hostname)) return undefined;
  if (!isAllowedHostname(url.hostname, extraAllowed)) return undefined;

  const port = url.port ? `:${url.port}` : "";
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.hostname}${port}${path}`;
}
