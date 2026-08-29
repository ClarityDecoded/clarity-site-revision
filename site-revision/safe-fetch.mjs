// Minimal SSRF guard for fetching a site_feedback row's page_url — a value
// that ultimately traces back to a visitor's browser (care-snippet.js sends
// `location.href`), not something this pipeline chose. Fetching it directly
// (added when generate.mjs learned to read a LIVE page instead of only
// website_sections.draft_html) is new outbound-request surface that didn't
// exist before, so it gets the same treatment crawler/safe-fetch.mjs already
// gives client-typed URLs: resolve the hostname and judge the ADDRESS, not
// just the string, so a public-looking name that resolves to 127.0.0.1 or
// 169.254.169.254 (cloud metadata) is refused rather than fetched. Kept as
// its own small copy rather than importing crawler/ — this package is
// dependency-free by design (gotcha #14 isolation) and the two run in
// different deploy targets (this one on a public repo).
import { lookup } from 'node:dns/promises';
import net from 'node:net';

export const TIMEOUT_MS = 15_000;
export const HTML_CAP = 2_000_000;

function isPrivateV4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateV6(ip) {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (s === '::1' || s === '::') return true;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  return /^f[cd]/.test(s) || /^fe[89ab]/.test(s);
}

function isPrivateAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) return isPrivateV6(ip);
  return true;
}

async function assertPublicHost(hostname) {
  const records = await lookup(hostname, { all: true });
  if (!records.length) throw new Error(`could not resolve ${hostname}`);
  for (const r of records) {
    if (isPrivateAddress(r.address)) throw new Error(`refusing to fetch a private address (${r.address})`);
  }
}

// Fetches a page_url captured by care-snippet.js and returns its HTML, or
// throws — caller (generate.mjs) treats that as any other generation
// failure (status='error', reason recorded).
export async function fetchLivePage(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('page_url is not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('page_url must be http(s)');
  const h = u.hostname.toLowerCase();
  // Cheap string-level reject before spending a DNS round trip — catches
  // "localhost" and a literal IP address typed straight into the URL.
  if (h === 'localhost' || h.endsWith('.localhost')) throw new Error('refusing to fetch localhost');
  if (net.isIP(h) && isPrivateAddress(h)) throw new Error(`refusing to fetch a private address (${h})`);
  await assertPublicHost(h);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(u.toString(), {
      signal: controller.signal,
      redirect: 'manual', // re-validate the target on every hop, same reasoning as crawler/safe-fetch.mjs
      headers: { 'User-Agent': 'ClarityCareSiteRevision/1.0 (+https://portal.claritydecoded.com)' },
    });
  } finally {
    clearTimeout(timer);
  }
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`page_url redirected (${res.status}) — refusing to follow blindly`);
  }
  if (!res.ok) throw new Error(`fetching page_url failed: ${res.status}`);
  const reader = res.body?.getReader?.();
  if (!reader) return (await res.text()).slice(0, HTML_CAP);
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
    if (out.length >= HTML_CAP) { out = out.slice(0, HTML_CAP); break; }
  }
  return out;
}
