// Turns a User-Agent header into something a person recognises on the
// sessions list ("Chrome on macOS"). Deliberately rough — it only has to
// help someone tell their laptop from their phone, not fingerprint anything.
// Pure; covered by scripts/test-security.ts.

export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";

  const browser =
    /Edg\//.test(ua)
      ? "Edge"
      : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua) && !/Chromium/.test(ua)
      ? "Chrome"
      : /Safari\//.test(ua) && /Version\//.test(ua)
      ? "Safari"
      : /curl\//i.test(ua)
      ? "curl"
      : null;

  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
    ? "iPad"
    : /Android/.test(ua)
    ? "Android"
    : /Windows/.test(ua)
    ? "Windows"
    : /Mac OS X|Macintosh/.test(ua)
    ? "macOS"
    : /CrOS/.test(ua)
    ? "ChromeOS"
    : /Linux/.test(ua)
    ? "Linux"
    : null;

  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Unknown device";
}

// Shortens an address for display and drops IPv6-mapped IPv4 noise.
export function displayIp(ip: string | null | undefined): string {
  if (!ip) return "—";
  return ip.replace(/^::ffff:/, "");
}
