// Shared browser test harness: real pages from web/ in Chromium, with a fake Supabase backend.
// Used by web.test.mjs and security.test.mjs.
import { before, after } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
// Playwright may be installed globally (preinstalled browser) or locally
const { chromium } = createRequire(import.meta.url)('playwright');

export const root = new URL('..', import.meta.url);
export const APP = 'http://app.test/';
export const API = 'https://test.supabase.co';
export const TOKEN = '11111111-2222-4333-8444-555555555555';
const types = { html: 'text/html', js: 'text/javascript', css: 'text/css' };

const bundle = new URL('tmp/supabase.esm.js', root);
if (!existsSync(bundle)) {
  execSync('npx esbuild node_modules/@supabase/supabase-js/dist/module/index.js --bundle --format=esm --platform=browser --outfile=tmp/supabase.esm.js --log-level=warning', { cwd: root });
}

let browser;
// Call once at the top of a test file: starts Chromium before its tests and closes it after
export function useBrowser() {
  before(async () => { browser = await chromium.launch(); });
  after(async () => { await browser?.close(); });
}
export const getBrowser = () => browser;

// Fake backend. `handlers` maps "METHOD /path" (prefix match) to fn(req) -> {status, json, headers}
export async function newPage(handlers, { session = false } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const calls = [];

  await page.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ contentType: 'text/javascript', body: readFileSync(bundle) }));
  await page.route('https://cdnjs.cloudflare.com/**', (r) => r.fulfill({
    contentType: 'text/javascript', body: readFileSync(new URL('node_modules/papaparse/papaparse.min.js', root)) }));
  await page.route(`${APP}**`, (r) => {
    const path = new URL(r.request().url()).pathname.replace(/^\//, '') || 'index.html';
    if (path === 'config.js') {
      return r.fulfill({ contentType: 'text/javascript',
        body: `export const SUPABASE_URL='${API}'; export const SUPABASE_ANON_KEY='test-anon-key';` });
    }
    const file = new URL(`web/${path}`, root);
    if (!existsSync(file)) return r.fulfill({ status: 404, body: 'not found' });
    return r.fulfill({ contentType: types[path.split('.').pop()] || 'application/octet-stream', body: readFileSync(file) });
  });
  await page.route(`${API}/**`, async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    const key = `${req.method()} ${url.pathname}`;
    const body = req.postDataBuffer();
    let json = null;
    try { json = body ? JSON.parse(body.toString()) : null; } catch { /* binary upload */ }
    const call = { key, url, json, body, headers: req.headers() };
    calls.push(call);
    const match = Object.keys(handlers).filter((k) => key.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    if (!match) return r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: `no mock for ${key}` }) });
    const res = await handlers[match](call, r);
    if (res === 'handled') return;
    const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range' };
    return r.fulfill({ status: res.status || 200, contentType: 'application/json', headers: { ...cors, ...(res.headers || {}) },
      body: res.json === undefined ? '' : JSON.stringify(res.json) });
  });

  if (session) {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u1', email: 'scorer@example.com', exp, role: 'authenticated' })}.sig`;
    const value = JSON.stringify({ access_token: jwt, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: exp,
      user: { id: 'u1', email: 'scorer@example.com', aud: 'authenticated', role: 'authenticated' } });
    await page.addInitScript((v) => localStorage.setItem('sb-test-auth-token', v), value);
  }
  page.on('console', (m) => { if (process.env.DEBUG) console.log('CONSOLE', m.type(), m.text()); });
  if (process.env.DEBUG) page.on('requestfailed', (q) => console.log('REQFAIL', q.url(), q.failure()?.errorText));
  if (process.env.DEBUG) page.on('response', (q) => { if (q.url().includes('supabase')) console.log('RESP', q.status(), q.request().method(), q.url()); });
  return { page, calls, errors, ctx };
}
