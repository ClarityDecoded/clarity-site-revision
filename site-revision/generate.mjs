#!/usr/bin/env node
// Turns a markup-tool comment (site_feedback, patch_033) into a targeted
// before/after HTML edit for the owner to review in SiteFeedback.jsx.
//
// Deliberately narrow scope, on purpose: the AI edits ONE element (the one
// the client clicked, found via the captured CSS selector), not the whole
// page. A full-page rewrite is a much bigger blast radius for something to
// go wrong, and "click a headline, ask for a change, see just that headline
// change" is also just a more honest preview of what happened.
//
// Runs the SAME text-editing model the reel worker uses (NVIDIA, OpenAI-
// compatible /chat/completions) but calls it directly rather than importing
// worker/router.mjs's full multi-provider machinery — this job makes one
// call per feedback item, not thousands, so the failover/pacing infra
// earns its keep there but is unneeded weight here. It DOES reuse the
// router's two-provider idea in miniature (NVIDIA primary, OpenRouter
// fallback) — see callModel below.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... NVIDIA_API_KEY=... node generate.mjs
//   (optionally) FEEDBACK_ID=<uuid> node generate.mjs   -- process just one row
//
// Every failure mode below is caught PER ITEM and written back as
// status='error' with a reason — never a crash that leaves a row stuck in
// 'new' forever, and never a thrown error that kills the rest of the batch.

import { parseHTML } from 'linkedom';
import * as db from './supabase.mjs';
import { installPrivateLogging } from './log-privacy.mjs';
import { withRetry } from './retry.mjs';

installPrivateLogging();

const NVIDIA_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_BASE = (process.env.NVIDIA_BASE || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '');
const NVIDIA_MODEL = process.env.NVIDIA_LLM_MODEL || 'meta/llama-3.3-70b-instruct';

// Primary model, Rahul's call (2026-08-21) — Kimi K2 via OpenRouter.
// Strong instruction-following for a narrow single-element edit like this.
// NOT a free-tier model — checked OpenRouter's own /models catalog and
// there is no `:free` Kimi variant (that suffix 404s outright); every
// current Kimi K2 snapshot draws down real OpenRouter account credits, at
// roughly $0.0000006/token prompt + $0.0000025/token completion — a
// fraction of a cent per edit, but real spend, not a free daily quota.
// NVIDIA is the fallback below, kept around specifically because of the
// 10-minute hang this same day (see callModel) — a second provider, not
// just a second attempt at the first one.
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE = (process.env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
const OPENROUTER_MODEL = process.env.OPENROUTER_LLM_MODEL || 'moonshotai/kimi-k2';

// A hung connection (no error, no response — what actually happened on
// 2026-08-21: 10 minutes of silence, force-killed by the workflow's own
// timeout) is worse than an HTTP error: withRetry never even sees it,
// because nothing ever rejects. AbortController turns "hangs forever" into
// "throws after N seconds", which withRetry (and then the NVIDIA->OpenRouter
// fallback below) can actually act on.
const CALL_TIMEOUT_MS = Number(process.env.MODEL_CALL_TIMEOUT_MS || 60000);

const SYSTEM_PROMPT = `You are editing ONE HTML element on a real website, based on specific user feedback from the site's owner or a client reviewing a draft.

Rules:
1. Never invent facts — no fabricated phone numbers, prices, statistics, testimonials, addresses, or claims that are not already present or directly implied by the requested change.
2. Preserve the existing HTML structure, tag name, and CSS classes unless the requested change specifically requires altering them.
3. Never introduce a <script> tag, inline event handler (onclick, onload, etc.), or a "javascript:" URL.
4. Return ONLY the raw revised HTML for this exact element. No markdown code fences, no explanation, no commentary — the response is inserted directly into the page.`;

function stripFences(text) {
  const t = text.trim();
  const fenced = t.match(/^```(?:html)?\n([\s\S]*?)\n?```$/);
  return (fenced ? fenced[1] : t).trim();
}

async function callCompletions(label, base, key, model, note, originalHtml, extraHeaders) {
  return withRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
        body: JSON.stringify({
          model,
          temperature: 0.3,
          max_tokens: 2000,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Requested change: ${note}\n\nCurrent HTML:\n${originalHtml}` },
          ],
        }),
      });
    } catch (e) {
      if (e.name === 'AbortError') {
        const err = new Error(`${label} timed out after ${CALL_TIMEOUT_MS}ms`);
        throw err; // no .status — a network-shaped failure, retried/failed-over like any other
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const err = new Error(`${label} ${res.status}: ${(await res.text()).slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content || !content.trim()) throw new Error(`empty response from ${label}`);
    return stripFences(content);
  });
}

// OpenRouter (Kimi K2 by default) primary, NVIDIA as fallback — only when
// a key for it is actually set, so this degrades to OpenRouter-only if
// NVIDIA_API_KEY is ever removed. Order is Rahul's call, 2026-08-21 — Kimi
// is the model he wants doing these edits day to day; NVIDIA stays as the
// safety net given today's hang.
async function callModel(note, originalHtml) {
  if (!OPENROUTER_KEY && !NVIDIA_KEY) throw new Error('OPENROUTER_API_KEY not set (and no NVIDIA_API_KEY fallback configured)');
  if (OPENROUTER_KEY) {
    try {
      return await callCompletions('OpenRouter', OPENROUTER_BASE, OPENROUTER_KEY, OPENROUTER_MODEL, note, originalHtml, {
        'HTTP-Referer': process.env.APP_URL || 'https://portal.claritydecoded.com',
        'X-Title': 'Clarity Site Revision',
      });
    } catch (e) {
      if (!NVIDIA_KEY) throw e;
      console.log(`[fallback] OpenRouter failed (${e.message}) — trying NVIDIA`);
    }
  }
  return callCompletions('NVIDIA', NVIDIA_BASE, NVIDIA_KEY, NVIDIA_MODEL, note, originalHtml);
}

// The captured selector can go stale if the page changed between the
// comment and this run (a re-seed, a manual edit). Fall back to finding the
// smallest element whose text content contains the captured element_text —
// best-effort, not exact, but better than failing outright on a page that
// mostly hasn't changed.
function findElement(document, selector, elementText) {
  if (selector) {
    try {
      const el = document.querySelector(selector);
      if (el) return el;
    } catch { /* an invalid/unsupported selector — fall through */ }
  }
  if (elementText && elementText.trim()) {
    const needle = elementText.trim();
    const all = [...document.querySelectorAll('*')];
    let best = null;
    for (const el of all) {
      const text = (el.textContent || '').trim();
      if (text === needle && (!best || el.children.length < best.children.length)) best = el;
    }
    if (best) return best;
  }
  return null;
}

function safetyCheck(html) {
  const lower = html.toLowerCase();
  if (lower.includes('<script') || /\son[a-z]+\s*=/.test(lower) || lower.includes('javascript:')) {
    throw new Error('model output rejected: contained a script tag, event handler, or javascript: URL');
  }
}

async function processOne(item) {
  await db.patch('site_feedback', `id=eq.${item.id}`, { status: 'generating' });

  try {
    const [section] = await db.select(
      'website_sections',
      `website_id=eq.${item.website_id}&route=eq.${encodeURIComponent(item.route || '')}&select=draft_html`,
    );
    if (!section?.draft_html) throw new Error(`no draft_html found for route "${item.route}"`);

    const { document } = parseHTML(section.draft_html);
    const el = findElement(document, item.selector, item.element_text);
    if (!el) throw new Error('could not locate the original element (selector and text both missed)');

    const originalOuterHtml = el.outerHTML;
    const revised = await callModel(item.note, originalOuterHtml);
    safetyCheck(revised);

    el.outerHTML = revised;
    const proposedDraftHtml = `<!DOCTYPE html>${document.documentElement.outerHTML}`;

    await db.patch('site_feedback', `id=eq.${item.id}`, {
      status: 'ready',
      original_outer_html: originalOuterHtml,
      proposed_outer_html: revised,
      original_draft_html: section.draft_html,
      proposed_draft_html: proposedDraftHtml,
      generation_error: null,
    });
    return 'ok';
  } catch (e) {
    await db.patch('site_feedback', `id=eq.${item.id}`, {
      status: 'error',
      generation_error: String(e.message || e).slice(0, 500),
    });
    return 'error';
  }
}

// A run killed mid-request (the workflow's own timeout-minutes, or a
// cancelled dispatch) leaves whatever item it was on stuck at
// status='generating' forever — processOne's own try/catch never gets a
// chance to write 'error' back, and main()'s query only ever looks at
// status=eq.new, so a stuck row is invisible to every future run. Safe to
// reclaim ALL of them unconditionally (not just aged ones) for the same
// reason reel-process.yml's reclaimStale() can: this workflow's
// concurrency group has cancel-in-progress:false, so only one run is ever
// actually working a row at a time — nothing can be "genuinely in
// progress elsewhere" when this runs at the top of a fresh job.
async function reclaimStuck() {
  const stuck = await db.select('site_feedback', `status=eq.generating&select=id`);
  for (const row of stuck) {
    await db.patch('site_feedback', `id=eq.${row.id}`, { status: 'new' });
  }
  if (stuck.length) console.log(`Reclaimed ${stuck.length} row(s) stuck on 'generating'.`);
}

async function main() {
  await reclaimStuck();

  const only = process.env.FEEDBACK_ID;
  const query = only
    ? `id=eq.${only}&select=*`
    : `status=eq.new&select=*&order=created_at.asc&limit=25`;
  const items = await db.select('site_feedback', query);

  if (!items.length) {
    console.log('No pending site feedback.');
    return;
  }

  let ok = 0, err = 0;
  for (const item of items) {
    const result = await processOne(item);
    if (result === 'ok') ok++; else err++;
    // No route/page here on purpose — see log-privacy.mjs: this pipeline's
    // logs may run on a public repo, and even a bare path is "which page on
    // which client's site."
    console.log(`[${result}] ${item.id}`);
  }
  console.log(`Site feedback generation — ok: ${ok}, error: ${err}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
