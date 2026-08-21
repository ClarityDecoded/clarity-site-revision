// `node test-log-privacy.mjs` — no network/DB/keys. Runs the filter against
// the ACTUAL error/log strings generate.mjs produces (not invented examples)
// — see CLAUDE.md gotcha #74e: a filter tested only against made-up strings
// missed a real leak on the reel worker's first public run.
import assert from 'node:assert/strict';
import { redact } from './log-privacy.mjs';

let n = 0;
function check(label, input, mustNotContain, mustContain) {
  n++;
  const out = redact(input);
  for (const bad of mustNotContain) {
    assert.ok(!out.includes(bad), `${label}: expected "${bad}" to be redacted, got: ${out}`);
  }
  for (const good of mustContain) {
    assert.ok(out.includes(good), `${label}: expected "${good}" to survive, got: ${out}`);
  }
}

// Real shapes from generate.mjs -------------------------------------------

check(
  'route in a "no draft_html" error',
  'no draft_html found for route "/hospice-and-home-health"',
  ['/hospice-and-home-health'],
  ['"…"'],
);

check(
  'NVIDIA error body echoing a fragment of the request',
  'NVIDIA 400: {"error":"invalid request","detail":"element: <h1 class=\\"hero\\">Diagnostics shouldn\'t require a resident transport.</h1>"}',
  ['resident transport', '<h1 class'],
  [],
);

check(
  'a raw HTML tag/attribute dumped into an error string outside quotes',
  'model returned unsafe output: <h1 onclick=steal()>',
  ['onclick'],
  ['<html>'],
);

check(
  'PostgREST error including a Supabase project URL',
  'select website_sections: 500 fetch failed at https://hozesxebdoviijvmjddp.supabase.co/rest/v1/website_sections',
  ['hozesxebdoviijvmjddp'],
  ['<url>'],
);

check(
  'a client note that leaked into an error string',
  'model output rejected for note: "make this nav more organized, need more categories"',
  ['make this nav more organized'],
  ['"…"'],
);

check(
  'plain status line — nothing to redact, must survive untouched',
  '[ok] 3f9c2b1a-8e2d-4a11-9c3e-1a2b3c4d5e6f',
  [],
  ['[ok] 3f9c2b1a-8e2d-4a11-9c3e-1a2b3c4d5e6f'],
);

check(
  'summary line — nothing to redact',
  'Site feedback generation — ok: 4, error: 1',
  [],
  ['Site feedback generation — ok: 4, error: 1'],
);

check(
  'an owner email address',
  'notify rahul@claritydecoded.com: generation failed',
  ['rahul@claritydecoded.com'],
  ['<email>'],
);

console.log(`✓ ${n} checks passed`);
