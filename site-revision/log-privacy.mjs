// Redact identifying detail from run logs.
//
// WHY THIS EXISTS: this pipeline reads site_feedback — a client's actual typed
// comment about their own site, plus the page's HTML before and after the AI
// edit. That is meaningfully more sensitive than the reel worker's saved-link
// titles (worker/log-privacy.mjs): it is a client's own words about their own
// business, not something Rahul chose to save. On a PUBLIC repo, Actions run
// logs are public to anyone — moving this job there to stop paying for Actions
// minutes must never turn a client's private feedback into a public one.
//
// generate.mjs deliberately never prints item.note or any HTML to begin with
// (only a status + a uuid, and error strings) — so there is little to redact
// today. This filter exists as the boundary backstop anyway, same reasoning
// as worker/log-privacy.mjs: a call-site-only approach is one forgotten
// template literal from leaking (this codebase has been bitten by exactly
// that shape twice — see CLAUDE.md gotchas #24, #52b), and a boundary filter
// also covers error text from libraries this file doesn't own (fetch, NVIDIA,
// PostgREST) and code that doesn't exist yet.
//
// OFF by default: a private repo's logs are the debugging surface and should
// stay complete. PUBLIC_LOGS=1 turns it on; the public repo's workflow sets it.

const URL_RE = /\bhttps?:\/\/\S+/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi;
// Quoted text covers route paths ("no draft_html found for route "/about-us""
// — a bare path is low-sensitivity alone, but is still "which page on which
// client's site") and, defensively, any stray HTML fragment or client note
// that ends up quoted in a future error string.
const QUOTED_RE = /"[^"\n]{1,400}"/g;
// A raw HTML tag outside quotes (outerHTML dumped straight into an error
// message, unquoted) — the actual page content this pipeline exists to edit.
const TAG_RE = /<[a-z][^<>]{0,300}>/gi;

export function redact(input) {
  if (typeof input !== "string") return input;
  // TAG_RE runs FIRST — its own placeholder ("<url>", "<email>") is itself
  // tag-shaped, so running it after would immediately eat what URL_RE/EMAIL_RE
  // just inserted.
  return input
    .replace(TAG_RE, "<html>")
    .replace(URL_RE, "<url>")
    .replace(EMAIL_RE, "<email>")
    .replace(QUOTED_RE, '"…"');
}

// An Error's message and stack go through the same filter — a thrown string
// here often carries the route or HTML that failed.
function scrubArg(a) {
  if (typeof a === "string") return redact(a);
  if (a instanceof Error) {
    const e = new Error(redact(a.message));
    e.stack = redact(a.stack || "");
    if (a.status) e.status = a.status;
    return e;
  }
  // Objects are not printed by this pipeline's own logs; stringifying one to
  // filter it would change what a future caller sees. Left alone deliberately
  // — if a future change starts logging rows, redact at that call site.
  return a;
}

export function installPrivateLogging(enabled = process.env.PUBLIC_LOGS === "1") {
  if (!enabled) return false;
  for (const level of ["log", "warn", "error", "info", "debug"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => original(...args.map(scrubArg));
  }
  console.log("[log-privacy] PUBLIC_LOGS=1 — urls, routes, quoted text and HTML are redacted from this log.");
  return true;
}
