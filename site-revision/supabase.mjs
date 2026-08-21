// Minimal PostgREST client — same idiom as runner/supabase.mjs and
// worker/*.mjs: plain fetch, service role, no SDK. This job reads/writes
// two tables and calls one LLM; an npm-installed SDK would be pure overhead.

import { withRetry } from './retry.mjs';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

function must() {
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
}

function headers(extra = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

export async function select(table, query) {
  must();
  return withRetry(async () => {
    const res = await fetch(`${url}/rest/v1/${table}?${query}`, { headers: headers() });
    if (!res.ok) throw new Error(`select ${table}: ${res.status} ${await res.text()}`);
    return res.json();
  });
}

export async function patch(table, query, body) {
  must();
  return withRetry(async () => {
    const res = await fetch(`${url}/rest/v1/${table}?${query}`, {
      method: 'PATCH',
      headers: headers({ Prefer: 'return=representation' }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`patch ${table}: ${res.status} ${await res.text()}`);
    return res.json();
  });
}
