// Browser tests: loads the real pages in Chromium with a fake Supabase backend.
// Run: npm test   (needs Playwright's Chromium; CDN libraries are served from node_modules)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
// Playwright may be installed globally (preinstalled browser) or locally
const { chromium } = createRequire(import.meta.url)('playwright');

const root = new URL('..', import.meta.url);
const APP = 'http://app.test/';
const API = 'https://test.supabase.co';
const TOKEN = '11111111-2222-4333-8444-555555555555';
const types = { html: 'text/html', js: 'text/javascript', css: 'text/css' };

const bundle = new URL('tmp/supabase.esm.js', root);
if (!existsSync(bundle)) {
  execSync('npx esbuild node_modules/@supabase/supabase-js/dist/module/index.js --bundle --format=esm --platform=browser --outfile=tmp/supabase.esm.js --log-level=warning', { cwd: root });
}

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

// Fake backend. `handlers` maps "METHOD /path" (prefix match) to fn(req) -> {status, json, headers}
async function newPage(handlers, { session = false } = {}) {
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

// A big, real JPEG made by the browser itself
async function bigJpeg() {
  const p = await browser.newPage();
  const b64 = await p.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 4000; c.height = 3000;
    const g = c.getContext('2d');
    for (let i = 0; i < 4000; i++) { g.fillStyle = `hsl(${i % 360},70%,${30 + (i % 40)}%)`; g.fillRect((i * 37) % 4000, (i * 53) % 3000, 120, 90); }
    return c.toDataURL('image/jpeg', 0.95).split(',')[1];
  });
  await p.close();
  return Buffer.from(b64, 'base64');
}

const session = () => ({
  event_name: 'SNAFU Test Rally', claims_open: true, max_attempts: 3,
  rider: { number: 42, name: 'Jane Smith' },
  bonuses: [
    { code: 'ABCD', name: 'Old mill', points: 100, description: 'Photo of the wheel', is_combo: false, attempts: 0, status: null },
    { code: 'WXYZ', name: 'Covered bridge', points: 50, is_combo: false, attempts: 1, status: 'approved' },
    { code: 'ARSN', name: 'Mill + bridge', points: 25, is_combo: true, attempts: 0, status: null },
  ],
});

test('rider: submit with photo, survives a dropped connection without re-uploading', async () => {
  let submitTries = 0;
  const { page, calls, errors } = await newPage({
    'POST /rest/v1/rpc/rider_session': () => ({ json: session() }),
    'POST /storage/v1/object/claims/': () => ({ json: { Key: 'claims/x' } }),
    'POST /rest/v1/rpc/rider_submit': (_c, r) => {
      submitTries++;
      if (submitTries === 1) { r.abort('internetdisconnected'); return 'handled'; }
      return { json: { claim_id: 'c1', status: 'pending', duplicate: false } };
    },
  });
  await page.goto(`${APP}rider.html?t=${TOKEN}`);
  await page.getByText('Rider 42 - Jane Smith').waitFor();
  assert.ok(await page.getByText('Approved').isVisible());

  if (process.env.SHOTS) { await page.setViewportSize({ width: 390, height: 760 }); await page.screenshot({ path: 'tmp/rider-list.png' }); }
  await page.getByRole('button', { name: /ABCD/ }).click();
  await page.getByRole('button', { name: 'Submit bonus' }).click();
  await page.getByText('Add a photo first.').waitFor();

  const jpeg = await bigJpeg();
  await page.setInputFiles('#photo', { name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  await page.getByRole('button', { name: 'Submit bonus' }).click();
  await page.getByText(/No signal/).waitFor();

  await page.getByRole('button', { name: 'Submit bonus' }).click();
  await page.getByText(/Received: ABCD/).waitFor();
  if (process.env.SHOTS) await page.screenshot({ path: 'tmp/rider-done.png' });

  const uploads = calls.filter((c) => c.key.startsWith('POST /storage/v1/object/claims/'));
  assert.equal(uploads.length, 1, 'photo uploaded exactly once');
  assert.match(uploads[0].key, new RegExp(`/claims/${TOKEN}/[0-9a-f-]{36}\\.jpg$`));
  assert.ok(uploads[0].body.length < jpeg.length / 3, `shrunk ${jpeg.length} -> ${uploads[0].body.length}`);

  const submits = calls.filter((c) => c.key === 'POST /rest/v1/rpc/rider_submit');
  assert.equal(submits.length, 2);
  assert.equal(submits[0].json.p_client_id, submits[1].json.p_client_id, 'retry reuses the same client id');
  assert.equal(submits[1].json.p_bonus_code, 'ABCD');
  assert.ok(submits[1].json.p_photo_path.startsWith(`${TOKEN}/`));
  assert.deepEqual(errors, []);
});

test('rider: combo can be sent without a photo; approved bonus is blocked; bad link explains itself', async () => {
  const { page, calls } = await newPage({
    'POST /rest/v1/rpc/rider_session': () => ({ json: session() }),
    'POST /rest/v1/rpc/rider_submit': () => ({ json: { claim_id: 'c2', status: 'pending' } }),
  });
  await page.goto(`${APP}rider.html?t=${TOKEN}`);
  await page.getByRole('button', { name: /WXYZ/ }).click();
  await page.getByText('already approved for you').waitFor();
  assert.equal(await page.isVisible('#claim-form'), false);

  await page.getByRole('button', { name: /All bonuses/ }).click();
  await page.getByRole('button', { name: /ARSN/ }).click();
  await page.getByText('not needed for a combo').waitFor();
  await page.getByRole('button', { name: 'Submit bonus' }).click();
  await page.getByText(/Received: ARSN/).waitFor();
  assert.equal(calls.find((c) => c.key === 'POST /rest/v1/rpc/rider_submit').json.p_photo_path, null);

  const bad = await newPage({
    'POST /rest/v1/rpc/rider_session': () => ({ status: 400, json: { code: 'P0001', message: 'This rider link is not valid. Ask the rally staff for a new one.' } }),
  });
  await bad.page.goto(`${APP}rider.html?t=${TOKEN}`);
  await bad.page.getByText('This rider link is not valid').waitFor();
});

test('scorer: sees pending claim with photo, deny needs a reason, approve calls the API', async () => {
  const { page, calls, errors } = await newPage({
    'POST /rest/v1/rpc/is_scorer': () => ({ json: true }),
    'GET /rest/v1/bonuses': () => ({ json: [{ code: 'ABCD', name: 'Old mill', points: 100 }] }),
    'HEAD /rest/v1/claims': () => ({ headers: { 'content-range': '0-0/1' } }),
    'GET /rest/v1/claims_detail': () => ({ json: [{
      id: 'c1', status: 'pending', bonus_code: 'ABCD', bonus_name: 'Old mill', points: 100, bonus_is_combo: false,
      rider_number: 42, rider_name: 'Jane Smith', submitted_at: new Date().toISOString(), submitted_by: 'rider 42',
      photo_path: `${TOKEN}/p.jpg`, note: 'sign was behind a tree' }] }),
    'POST /storage/v1/object/sign/claims': (c) => ({ json: c.json.paths.map((p) => ({ path: p, signedURL: `/object/sign/claims/${p}?token=t`, error: null })) }),
    'POST /rest/v1/rpc/scorer_decide': () => ({ json: { id: 'c1', status: 'approved' } }),
  }, { session: true });
  await page.goto(`${APP}scorer.html`);
  await page.locator('.claim').getByText('Rider 42 - Jane Smith').waitFor();
  assert.ok(await page.getByText('Pending (1)').isVisible());
  assert.ok(await page.getByText('sign was behind a tree').isVisible());
  assert.match(await page.getAttribute('.claim img', 'src'), /object\/sign\/claims\/.*p\.jpg/);

  if (process.env.SHOTS) { await page.setViewportSize({ width: 900, height: 700 }); await page.screenshot({ path: 'tmp/scorer.png' }); }
  await page.getByRole('button', { name: 'Deny' }).click();
  await page.getByText('Enter a reason to deny.').waitFor();
  assert.equal(calls.filter((c) => c.key.includes('scorer_decide')).length, 0);

  await page.getByRole('button', { name: 'Approve' }).click();
  await page.waitForResponse((r) => r.url().includes('scorer_decide'));
  const d = calls.find((c) => c.key.includes('scorer_decide')).json;
  assert.deepEqual(d, { p_claim_id: 'c1', p_status: 'approved', p_reason: null });
  assert.deepEqual(errors, []);
});

test('scorer: signed-out user gets the email login; non-scorer is told so', async () => {
  const { page } = await newPage({});
  await page.goto(`${APP}scorer.html`);
  await page.getByText('Scorer sign in').waitFor();

  const other = await newPage({ 'POST /rest/v1/rpc/is_scorer': () => ({ json: false }) }, { session: true });
  await other.page.goto(`${APP}scorer.html`);
  await other.page.getByText('is not on the scorer list').waitFor();
});

test('admin: CSV import validates, then upserts riders with the sheet column names', async () => {
  const { page, calls, errors } = await newPage({
    'POST /rest/v1/rpc/is_scorer': () => ({ json: true }),
    'GET /rest/v1/settings': () => ({ json: { id: 1, event_name: 'SNAFU Test Rally', max_attempts: 3, claims_open: true } }),
    'GET /rest/v1/riders': () => ({ json: [{ rider_number: 42, name: 'Jane Smith', email: 'jane@example.com', token: TOKEN }] }),
    'POST /rest/v1/riders': () => ({ status: 201, json: [] }),
    'POST /rest/v1/bonuses': () => ({ status: 201, json: [] }),
  }, { session: true });
  await page.goto(`${APP}admin.html`);
  await page.getByRole('heading', { name: 'Rider links' }).waitFor();
  assert.equal(await page.inputValue('#s-name'), 'SNAFU Test Rally');
  assert.match(await page.getAttribute('#links a', 'href'), new RegExp(`rider\\.html\\?t=${TOKEN}$`));

  const csv = 'Rider Number,Name,Email\n42,Jane Smith,JANE@example.com\n7,Bob Jones,\n\n';
  await page.setInputFiles('[data-kind="riders"]', { name: 'riders.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByText('2 rows look good').waitFor();
  await page.click('[data-import="riders"]');
  await page.getByText('Imported 2 riders.').waitFor();
  const up = calls.find((c) => c.key === 'POST /rest/v1/riders');
  assert.equal(up.url.searchParams.get('on_conflict'), 'rider_number');
  assert.deepEqual(up.json, [
    { rider_number: 42, name: 'Jane Smith', email: 'jane@example.com' },
    { rider_number: 7, name: 'Bob Jones', email: null },
  ]);

  const bad = 'Bonus ID,POINTS\nABCD,100\nAB12,50\nWXYZ,lots\n';
  await page.setInputFiles('[data-kind="bonuses"]', { name: 'b.csv', mimeType: 'text/csv', buffer: Buffer.from(bad) });
  await page.getByText(/"AB12" is not 4 letters/).waitFor();
  assert.ok(await page.getByText(/points "lots"/).isVisible());
  assert.equal(await page.isDisabled('[data-import="bonuses"]'), true);
  assert.deepEqual(errors, []);
});

test('leader board renders scores', async () => {
  const { page, errors } = await newPage({
    'POST /rest/v1/rpc/leaderboard': () => ({ json: [
      { finish: 1, rider_number: 42, name: 'Jane Smith', score: 131.25, bonuses_counted: 3 },
      { finish: 2, rider_number: 7, name: 'Bob Jones', score: 0, bonuses_counted: 0 }] }),
  });
  await page.goto(`${APP}leaderboard.html`);
  await page.getByText('131.25').waitFor();
  assert.ok(await page.getByText('Bob Jones').isVisible());
  assert.deepEqual(errors, []);
});
