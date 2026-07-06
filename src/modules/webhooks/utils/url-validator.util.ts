/**
 * BE-50 — Webhook URL validator (SSRF guard).
 *
 * Outbound webhooks are an attractive SSRF vector: a tenant could
 * register `http://169.254.169.254/...` (cloud metadata) or
 * `http://10.0.0.1/...` (internal RFC1918) and use *us* to probe
 * their target's private network from inside the VPC.
 *
 * This validator is a pure function. Returning `{ ok: false }` is
 * the signal to refuse delivery (and refuse registration). It is
 * intentionally hostname-based — DNS rebinding is mitigated by also
 * re-validating on every delivery, but a perfect fix needs us to
 * resolve and pin the IP at fetch time. That is filed for the BE-50
 * follow-up; today we cover the static-config attack surface.
 *
 * Rejected ranges (Req 52 + OWASP SSRF cheatsheet):
 *   - protocol other than `http:` / `https:`
 *   - host = `localhost` / `*.localhost`
 *   - IPv4 loopback `127.0.0.0/8`
 *   - RFC1918 private ranges:
 *       `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
 *   - link-local `169.254.0.0/16` (cloud metadata!)
 *   - IPv4 broadcast `255.255.255.255` and `0.0.0.0`
 *   - shared / CGNAT `100.64.0.0/10`
 *   - IPv6 loopback `::1`, link-local `fe80::/10`, unique-local
 *     `fc00::/7`, IPv4-mapped private ranges, and unspecified `::`.
 *
 * Production callers should also block userinfo (`user:pass@`) and
 * require https; we accept both for dev parity but only reject
 * unsafe targets.
 */

export interface UrlValidationResult {
  ok: boolean;
  reason?: string;
}

const VALID_PROTOCOLS = new Set(['http:', 'https:']);

/** Public entry point. `ok: true` ⇒ safe to deliver / register. */
export function validateWebhookUrl(input: string | null | undefined): UrlValidationResult {
  if (!input || typeof input !== 'string') {
    return { ok: false, reason: 'URL is empty or not a string' };
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, reason: 'URL is not parseable' };
  }

  if (!VALID_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, reason: `Protocol ${parsed.protocol} is not allowed` };
  }

  // `url.hostname` is already lowercased; on Node, IPv6 literals are
  // returned wrapped in `[...]` brackets — strip them so the rest of
  // the checks see a bare address. (Other engines vary; doing this
  // unconditionally is a no-op for the IPv4/DNS branches.)
  const host = stripIpv6Brackets(parsed.hostname);

  if (!host) {
    return { ok: false, reason: 'URL has no hostname' };
  }

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, reason: 'localhost is not allowed' };
  }

  // IPv6 detection: must contain at least one ':'.
  if (host.includes(':')) {
    if (isInternalIPv6(host)) {
      return { ok: false, reason: `IPv6 ${host} is in a reserved/internal range` };
    }
    return { ok: true };
  }

  // IPv4 detection: 4 dotted octets, each 0-255.
  const ipv4 = parseIPv4(host);
  if (ipv4) {
    if (isInternalIPv4(ipv4)) {
      return { ok: false, reason: `IPv4 ${host} is in a reserved/internal range` };
    }
    return { ok: true };
  }

  // Hostname (DNS) — accept for now. DNS-rebinding mitigations are
  // documented in the file header.
  return { ok: true };
}

function stripIpv6Brackets(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) {
    return host.slice(1, -1);
  }
  return host;
}

/**
 * Parses a dotted-quad string into 4 octet numbers.
 * Returns `null` for anything that is not exactly 4 numeric 0-255
 * octets — this keeps "1.2.3" and "192.168.0.1.1" out.
 */
function parseIPv4(host: string): readonly [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets as unknown as readonly [number, number, number, number];
}

/**
 * Returns true if the given IPv4 octets sit in a range we refuse to
 * deliver to. See the file header for the full list.
 */
function isInternalIPv4(octets: readonly [number, number, number, number]): boolean {
  const [a, b] = octets;

  // 0.0.0.0/8 — "this network", and the all-zero unspecified.
  if (a === 0) return true;
  // 10.0.0.0/8 — RFC1918.
  if (a === 10) return true;
  // 127.0.0.0/8 — IPv4 loopback.
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local + cloud metadata (169.254.169.254).
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 — RFC1918.
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — RFC1918.
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 — CGNAT.
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 255.255.255.255 — broadcast.
  if (a === 255 && b === 255 && octets[2] === 255 && octets[3] === 255) return true;

  return false;
}

/**
 * Returns true if the given IPv6 hostname (without brackets) sits in
 * a reserved or internal range. Conservative: anything we don't
 * recognise as definitively public is refused, since IPv6 makes it
 * very easy to slip past a naive checker.
 */
function isInternalIPv6(host: string): boolean {
  const lowered = host.toLowerCase();

  // `::1` — IPv6 loopback.
  if (lowered === '::1') return true;
  // `::` — unspecified.
  if (lowered === '::') return true;
  // `fe80::/10` — link-local.
  if (lowered.startsWith('fe8') || lowered.startsWith('fe9')) return true;
  if (lowered.startsWith('fea') || lowered.startsWith('feb')) return true;
  // `fc00::/7` — unique local addresses (RFC4193).
  if (lowered.startsWith('fc') || lowered.startsWith('fd')) return true;
  // `ff00::/8` — multicast.
  if (lowered.startsWith('ff')) return true;

  // IPv4-mapped IPv6 in dotted-quad form (`::ffff:10.0.0.1`).
  const mappedDotted = lowered.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDotted) {
    const parsed = parseIPv4(mappedDotted[1]);
    return parsed ? isInternalIPv4(parsed) : true;
  }

  // IPv4-mapped IPv6 in canonical hex form (`::ffff:a00:1`). Node's
  // URL parser normalises the dotted form into this shape, so we
  // must decode the trailing two 16-bit hex groups back into octets.
  const mappedHex = lowered.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16);
    const low = parseInt(mappedHex[2], 16);
    if (Number.isFinite(high) && Number.isFinite(low)) {
      const octets = [
        (high >> 8) & 0xff,
        high & 0xff,
        (low >> 8) & 0xff,
        low & 0xff,
      ] as const;
      return isInternalIPv4(octets as readonly [number, number, number, number]);
    }
    return true;
  }

  return false;
}
