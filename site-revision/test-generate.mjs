#!/usr/bin/env node
// Exercises the deterministic parts of generate.mjs (element finding, DOM
// mutation, safety check) against the REAL Lemedix homepage HTML and the
// REAL selector format care-snippet.js produces — no network, no DB, no
// LLM key needed. `node test-generate.mjs`

import { parseHTML } from 'linkedom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`ok — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}`); }
}

// ---- inline the same findElement/safetyCheck logic (kept identical to generate.mjs) ----
function findElement(document, selector, elementText) {
  if (selector) {
    try {
      const el = document.querySelector(selector);
      if (el) return el;
    } catch { /* ignore */ }
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
    throw new Error('rejected');
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(here, '..', 'sites', 'lemedix-pleasanton', '_build', 'draft-pages.json');
const pages = JSON.parse(readFileSync(manifestPath, 'utf8'));
const home = pages.find((p) => p.route === '/');
check('homepage found in manifest', !!home);

// ---- real selector from Rahul's actual test comment ----
{
  const { document } = parseHTML(home.html);
  const selector = 'body > div.proof-strip:nth-of-type(1) > div.container';
  const el = findElement(document, selector, null);
  check('real captured selector resolves', !!el);
  check('resolved element is the proof strip', el && el.className.includes('proof-grid'));
}

// ---- selector-miss falls back to element_text match ----
{
  const { document } = parseHTML(home.html);
  const el = findElement(document, 'body > .this-does-not-exist', 'Talk to Our Pleasanton Team');
  check('text fallback finds the element when selector is stale', !!el);
  check('text fallback matched exact text', el && el.textContent.trim() === 'Talk to Our Pleasanton Team');
}

// ---- both selector and text miss -> null, not a throw ----
{
  const { document } = parseHTML(home.html);
  const el = findElement(document, 'body > .nope', 'this text does not exist anywhere on the page');
  check('total miss returns null, does not throw', el === null);
}

// ---- full mutate + reserialize round trip preserves the rest of the page ----
{
  const { document } = parseHTML(home.html);
  const el = document.querySelector('h1');
  const before = el.outerHTML;
  el.outerHTML = '<h1>Replaced Headline</h1>';
  const full = `<!DOCTYPE html>${document.documentElement.outerHTML}`;
  check('mutation applied', full.includes('Replaced Headline'));
  check('original headline gone', !full.includes(before.replace(/<[^>]+>/g, '').trim()) || before.includes('Replaced'));
  check('base64 image data survived the round trip', full.includes('data:image/webp;base64,') || full.includes('data:image/jpeg;base64,'));
  check('page did not shrink drastically (no data loss)', full.length > home.html.length * 0.95);
}

// ---- safety check blocks script injection ----
{
  let threw = false;
  try { safetyCheck('<div>hi<script>alert(1)</script></div>'); } catch { threw = true; }
  check('safetyCheck rejects <script>', threw);
}
{
  let threw = false;
  try { safetyCheck('<div onclick="alert(1)">hi</div>'); } catch { threw = true; }
  check('safetyCheck rejects inline event handler', threw);
}
{
  let threw = false;
  try { safetyCheck('<a href="javascript:alert(1)">hi</a>'); } catch { threw = true; }
  check('safetyCheck rejects javascript: URL', threw);
}
{
  let threw = false;
  try { safetyCheck('<div class="card"><h3>Fine</h3><p>Ordinary content</p></div>'); } catch { threw = true; }
  check('safetyCheck allows ordinary HTML', !threw);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
