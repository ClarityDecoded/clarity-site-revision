// Minimal retry-with-backoff for this job's two network calls (NVIDIA,
// Supabase PostgREST). Deliberately its own small copy rather than an
// import from worker/retry.mjs — site-revision is an isolated deployable
// (own package.json, gotcha #14) that ships to a separate public repo, so
// it can't reach across into worker/ at runtime.
//
// Same shape as worker/retry.mjs on purpose (gotcha #24: keep option names
// a contract) — { retries, base, cap, shouldRetry } — even though this copy
// is independent.
//
// A bare "fetch failed" (no err.status — DNS/connection reset/TLS blip) is
// exactly what withRetry exists for: one network hiccup during either the
// NVIDIA call or the Supabase read used to permanently mark a site_feedback
// item 'error' with no retry, showing the owner "COULD NOT GENERATE" for
// something that would very likely succeed on a second attempt.
export async function withRetry(fn, { retries = 3, base = 500, cap = 8000, shouldRetry = defaultShouldRetry } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      if (attempt > retries || !shouldRetry(e)) throw e;
      const delay = Math.min(cap, base * 2 ** (attempt - 1)) * (0.5 + Math.random() * 0.5);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function defaultShouldRetry(err) {
  const status = err?.status ?? parseStatus(err?.message);
  if (status == null) return true; // a network throw with no status — the "fetch failed" case
  return status === 429 || status === 408 || status >= 500;
}

function parseStatus(message) {
  const m = /\b(\d{3})\b/.exec(message || '');
  return m ? Number(m[1]) : null;
}
