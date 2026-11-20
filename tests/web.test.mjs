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

// A 1x1 PNG, served for photo links
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const servePng = (_c, r) => { r.fulfill({ contentType: 'image/png', body: PNG, headers: { 'access-control-allow-origin': '*' } }); return 'handled'; };
const navLinks = (page) => page.$$eval('nav.nav a', (els) => els.map((e) => e.textContent));

// Wait until the page has made a matching API call
async function callMade(page, calls, pred) {
  for (let i = 0; i < 100; i++) {
    const c = calls.find(pred);
    if (c) return c;
    await page.waitForTimeout(50);
  }
  throw new Error('expected API call was not made');
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
  score: { total: 50, base_points: 50, worst_penalty: null, bonuses_counted: 1 },
  bonuses: [
    { code: 'ABCD', name: 'Old mill', points: 100, description: 'Photo of the wheel', is_combo: false, attempts: 0, status: null, counted: false, ref_photo: 'ABCD/ref.jpg' },
    { code: 'WXYZ', name: 'Covered bridge', points: 50, is_combo: false, attempts: 1, status: 'approved', counted: true },
    { code: 'ARSN', name: 'Mill + bridge', points: 25, is_combo: true, attempts: 0, status: null, counted: false },
  ],
});

// One bonus in every state, for the score / grouping / filter test
const busySession = () => ({
  ...session(),
  score: { total: 1234.5, base_points: 1371.67, worst_penalty: -10, bonuses_counted: 2 },
  bonuses: [
    { code: 'ABCD', name: 'Old mill', points: 100, is_combo: false, attempts: 0, status: null, counted: false },
    { code: 'WXYZ', name: 'Covered bridge', points: 50, is_combo: false, attempts: 1, status: 'approved', counted: true },
    { code: 'ARSN', name: 'Mill + bridge', points: 25, is_combo: true, attempts: 0, status: null, counted: true },
    { code: 'PEND', name: 'Waiting one', points: 10, is_combo: false, attempts: 1, status: 'pending', counted: false },
    { code: 'DENY', name: 'Denied once', points: 20, is_combo: false, attempts: 1, status: 'denied', counted: false },
    { code: 'DEAD', name: 'Out of tries', points: 30, is_combo: false, attempts: 3, status: 'denied', counted: false },
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
  assert.ok(await page.locator('.badge.approved', { hasText: 'Approved' }).isVisible());

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

test('rider: score at the top; claimed bonuses grouped, filtered and remembered', async () => {
  const { page, errors } = await newPage({
    'POST /rest/v1/rpc/rider_session': () => ({ json: busySession() }),
  });
  const codes = () => page.$$eval('#bonus-list [data-code]', (els) => els.map((e) => e.dataset.code));
  const heads = () => page.$$eval('#bonus-list .group-head', (els) => els.map((e) => e.textContent));

  await page.goto(`${APP}rider.html?t=${TOKEN}`);
  await page.getByText('Rider 42 - Jane Smith').waitFor();
  assert.equal(await page.textContent('#score-total'), (1234.5).toLocaleString('en-US'));
  assert.equal(await page.textContent('#score-line'),
    '2 bonuses approved - 1 waiting for review - includes a -10% penalty');

  // Default: all, grouped. Denied with tries left is in both tabs, but listed once here (to get).
  assert.deepEqual(await heads(), ['To get (2)', 'Claimed (4)']);
  assert.deepEqual(await codes(), ['ABCD', 'DENY', 'WXYZ', 'ARSN', 'PEND', 'DEAD']);
  assert.equal(await page.textContent('#n-todo'), '2');
  assert.equal(await page.textContent('#n-claimed'), '5');
  assert.ok(await page.getByText('Counted - all parts approved').isVisible());
  assert.ok(await page.getByText('Denied - no attempts left').isVisible());
  if (process.env.SHOTS) { await page.setViewportSize({ width: 390, height: 860 }); await page.screenshot({ path: 'tmp/rider-grouped.png' }); }

  // Ungrouped keeps the event's own order
  await page.getByLabel('Group claimed bonuses together').uncheck();
  assert.deepEqual(await heads(), []);
  assert.deepEqual(await codes(), ['ABCD', 'WXYZ', 'ARSN', 'PEND', 'DENY', 'DEAD']);

  // "To get" skips everything already claimed; search works inside it
  await page.getByRole('tab', { name: /To get/ }).click();
  assert.deepEqual(await codes(), ['ABCD', 'DENY']);
  assert.equal(await page.isVisible('#group-wrap'), false);
  await page.fill('#search', 'mill');
  assert.deepEqual(await codes(), ['ABCD']);
  await page.fill('#search', '');

  await page.getByRole('tab', { name: /Claimed/ }).click();
  assert.deepEqual(await codes(), ['WXYZ', 'ARSN', 'PEND', 'DENY', 'DEAD']);

  // Choice is remembered on the phone
  await page.reload();
  await page.getByText('Rider 42 - Jane Smith').waitFor();
  assert.equal(await page.getAttribute('#filter-tabs [data-filter="claimed"]', 'aria-selected'), 'true');
  assert.deepEqual(await codes(), ['WXYZ', 'ARSN', 'PEND', 'DENY', 'DEAD']);

  // A combo that already counts cannot be sent again
  await page.getByRole('button', { name: /ARSN/ }).click();
  await page.getByText('This combo already counts').waitFor();
  assert.equal(await page.isVisible('#claim-form'), false);
  assert.deepEqual(errors, []);
});

test('rider: sees past submissions with the reason, and their photo on tap', async () => {
  const sess = session();
  sess.bonuses[0] = { ...sess.bonuses[0], attempts: 2, status: 'denied', history: [
    { status: 'denied', submitted_at: new Date().toISOString(), photo_path: `${TOKEN}/b.jpg`, reason: 'flag not visible', by_staff: false },
    { status: 'denied', submitted_at: new Date(Date.now() - 3600e3).toISOString(), photo_path: `${TOKEN}/a.jpg`, reason: 'too dark', by_staff: false },
  ] };
  const { page, calls, errors } = await newPage({
    'POST /rest/v1/rpc/rider_session': () => ({ json: sess }),
    // a.jpg was deleted from storage, so only b.jpg comes back
    'POST /functions/v1/rider-photo': () => ({ json: { photos: { [`${TOKEN}/b.jpg`]: `/storage/v1/object/sign/claims/${TOKEN}/b.jpg?token=x` } } }),
    'GET /storage/v1/object/sign/claims/': (_c, r) => { r.fulfill({ contentType: 'image/png', body: PNG }); return 'handled'; },
  });
  await page.goto(`${APP}rider.html?t=${TOKEN}`);
  await page.getByRole('button', { name: /ABCD/ }).click();
  await page.getByText('Your submissions').waitFor();
  assert.ok(await page.getByText('Reason: flag not visible').isVisible());
  assert.ok(await page.getByText('Reason: too dark').isVisible());
  assert.equal(await page.locator('[data-photo]').count(), 2);
  assert.equal(calls.filter((c) => c.key.includes('rider-photo')).length, 0, 'no photo traffic until asked');

  await page.locator('[data-photo]').first().click();
  await page.locator('img[data-path]').waitFor();
  const fn = calls.filter((c) => c.key === 'POST /functions/v1/rider-photo');
  assert.equal(fn.length, 1, 'one call fetches every photo for the bonus');
  assert.deepEqual(fn[0].json, { token: TOKEN, paths: [`${TOKEN}/b.jpg`, `${TOKEN}/a.jpg`] });
  assert.equal(await page.getAttribute('img[data-path]', 'src'), `${API}/storage/v1/object/sign/claims/${TOKEN}/b.jpg?token=x`);
  assert.ok(await page.getByText('Photo not found.').isVisible());
  assert.ok(await page.locator('#claim-form').isVisible(), 'can still try again (2 of 3 attempts)');
  if (process.env.SHOTS) { await page.setViewportSize({ width: 390, height: 900 }); await page.screenshot({ path: 'tmp/rider-history.png', fullPage: true }); }

  // A bonus with no submissions shows no history section
  await page.getByRole('button', { name: /All bonuses/ }).click();
  await page.getByRole('button', { name: /ARSN/ }).click();
  assert.equal(await page.isVisible('#c-history'), false);
  assert.deepEqual(errors, []);
});

test('rider: photo viewer explains a failure and lets the rider retry', async () => {
  const sess = session();
  sess.bonuses[1] = { ...sess.bonuses[1], history: [
    { status: 'approved', submitted_at: new Date().toISOString(), photo_path: `${TOKEN}/w.jpg`, reason: null, by_staff: false }] };
  const { page, errors } = await newPage({
    'POST /rest/v1/rpc/rider_session': () => ({ json: sess }),
    'POST /functions/v1/rider-photo': () => ({ status: 400, json: { message: 'This rider link is not valid. Ask the rally staff for a new one.' } }),
  });
  await page.goto(`${APP}rider.html?t=${TOKEN}`);
  await page.getByRole('button', { name: /WXYZ/ }).click();
  await page.getByRole('button', { name: 'Show photo' }).click();
  await page.locator('#c-history-msg', { hasText: 'rider link is not valid' }).waitFor();
  assert.ok(await page.getByRole('button', { name: 'Show photo' }).isEnabled(), 'button is back for a retry');
  assert.deepEqual(errors, []);
});

test('scorer: sees pending claim with photo, deny needs a reason, approve calls the API', async () => {
  const { page, calls, errors } = await newPage({
    'POST /rest/v1/rpc/staff_role': () => ({ json: 'scorer' }),
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
  assert.deepEqual(await navLinks(page), ['Review', 'Activity', 'Leader board'], 'no Admin link for a scorer');
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

test('scorer: table view is sortable, decides from the row, and is remembered', async () => {
  const now = Date.now();
  const claim = (id, rider, code, points, minsAgo, extra = {}) => ({
    id, status: 'pending', bonus_code: code, bonus_name: `Bonus ${code}`, points, bonus_is_combo: false,
    rider_number: rider, rider_name: `Rider ${rider}`, submitted_at: new Date(now - minsAgo * 60000).toISOString(),
    submitted_by: `rider ${rider}`, photo_path: `${TOKEN}/${id}.jpg`, ...extra });
  const { page, calls, errors } = await newPage({
    'POST /rest/v1/rpc/staff_role': () => ({ json: 'scorer' }),
    'GET /rest/v1/bonuses': () => ({ json: [] }),
    'HEAD /rest/v1/claims': () => ({ headers: { 'content-range': '0-2/3' } }),
    'GET /rest/v1/claims_detail': () => ({ json: [
      claim('c1', 42, 'ABCD', 100, 30), claim('c2', 7, 'WXYZ', 50, 10), claim('c3', 15, 'ABC1', 10, 20, { note: 'blurry sign' }),
    ] }),
    'POST /storage/v1/object/sign/claims': (c) => ({ json: c.json.paths.map((p) => ({ path: p, signedURL: `/object/sign/claims/${p}?token=t`, error: null })) }),
    'POST /rest/v1/rpc/scorer_decide': () => ({ json: { id: 'c2', status: 'denied' } }),
  }, { session: true });
  const ids = () => page.$$eval('#table-pending tbody [data-act="approved"]', (els) => els.map((e) => e.dataset.id));

  await page.goto(`${APP}scorer.html`);
  await page.locator('.claim').first().waitFor();
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await page.locator('#table-pending [data-act="approved"]').first().waitFor();
  assert.equal(await page.locator('.claim').count(), 0, 'cards are gone in table view');
  assert.deepEqual(await ids(), ['c1', 'c3', 'c2'], 'oldest first by default');
  assert.equal(await page.locator('#table-pending img.thumb').count(), 3);
  assert.ok(await page.getByRole('cell', { name: 'blurry sign' }).isVisible());

  await page.getByRole('button', { name: 'Points' }).click();     // first click: highest first
  assert.deepEqual(await ids(), ['c1', 'c2', 'c3']);
  assert.equal(await page.getAttribute('th:has(button[data-sort="points"])', 'aria-sort'), 'descending');
  await page.getByRole('button', { name: 'Rider', exact: true }).click();
  assert.deepEqual(await ids(), ['c2', 'c3', 'c1']);              // 7, 15, 42
  if (process.env.SHOTS) { await page.setViewportSize({ width: 1200, height: 520 }); await page.screenshot({ path: 'tmp/scorer-table.png' }); }

  // Deny from the row needs that row's reason
  const row = page.locator('#table-pending tr', { has: page.locator('[data-id="c2"]') });
  await row.getByRole('button', { name: 'Deny' }).click();
  await page.getByText('Enter a reason to deny.').waitFor();
  await row.getByRole('textbox').fill('wrong bridge');
  await row.getByRole('button', { name: 'Deny' }).click();
  await page.waitForResponse((r) => r.url().includes('scorer_decide'));
  assert.deepEqual(calls.find((c) => c.key.includes('scorer_decide')).json,
    { p_claim_id: 'c2', p_status: 'denied', p_reason: 'wrong bridge' });

  // View and sort are remembered
  await page.reload();
  await page.locator('#table-pending [data-act="approved"]').first().waitFor();
  assert.deepEqual(await ids(), ['c2', 'c3', 'c1']);
  assert.deepEqual(errors, []);
});

test('activity: tiles, claim feed, riders never seen, scorer sign-ins', async () => {
  const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
  const { page, errors } = await newPage({
    'POST /rest/v1/rpc/staff_role': () => ({ json: 'admin' }),
    'GET /rest/v1/claim_activity': () => ({ json: [
      { id: 3, at: ago(2), action: 'approved', actor: 'scorer@example.com', rider_number: 42, rider_name: 'Jane Smith', bonus_code: 'ABCD', bonus_name: 'Old mill', points: 100 },
      { id: 2, at: ago(5), action: 'denied', actor: 'scorer@example.com', rider_number: 7, rider_name: 'Bob Jones', bonus_code: 'WXYZ', bonus_name: 'Covered bridge', points: 50, reason: 'wrong bridge' },
      { id: 1, at: ago(9), action: 'submitted', actor: 'rider 42', rider_number: 42, rider_name: 'Jane Smith', bonus_code: 'ABCD', bonus_name: 'Old mill', points: 100 },
    ] }),
    'GET /rest/v1/rider_activity': () => ({ json: [
      { rider_number: 42, name: 'Jane Smith', last_seen_at: ago(3), claims: 2, pending: 1, approved: 1, denied: 0, last_claim_at: ago(9), score: 100 },
      { rider_number: 7, name: 'Bob Jones', last_seen_at: ago(30), claims: 1, pending: 0, approved: 0, denied: 1, last_claim_at: ago(40), score: 0 },
      { rider_number: 15, name: 'Ana Diaz', last_seen_at: null, claims: 0, pending: 0, approved: 0, denied: 0, last_claim_at: null, score: 0 },
    ] }),
    'POST /rest/v1/rpc/scorer_list': () => ({ json: [{ email: 'scorer@example.com', last_sign_in_at: ago(60 * 24) }] }),
  }, { session: true });

  await page.goto(`${APP}activity.html`);
  await page.locator('#feed table.data').waitFor();
  assert.equal(await page.textContent('#t-seen'), '2 / 3');
  assert.equal(await page.textContent('#t-claimed'), '2 / 3');
  assert.equal(await page.textContent('#t-pending'), '1');
  assert.equal(await page.textContent('#t-last'), '9 min ago');
  assert.equal(await page.locator('#feed tbody tr').count(), 3);
  assert.ok(await page.getByRole('cell', { name: 'Rider 42' }).isVisible());
  assert.ok(await page.getByRole('cell', { name: 'wrong bridge' }).isVisible());
  await page.fill('#feed-filter', '7');
  assert.equal(await page.locator('#feed tbody tr').count(), 1);
  if (process.env.SHOTS) { await page.setViewportSize({ width: 1200, height: 700 }); await page.fill('#feed-filter', ''); await page.screenshot({ path: 'tmp/activity-feed.png' }); }

  await page.getByRole('button', { name: 'Riders', exact: true }).click();
  const nums = () => page.$$eval('#riders tbody tr td:first-child', (els) => els.map((e) => e.textContent));
  assert.deepEqual(await nums(), ['7', '15', '42']);
  assert.equal(await page.locator('#riders tr.attention').count(), 1, 'never-seen rider highlighted');
  await page.getByRole('button', { name: 'Last seen' }).click();   // newest first
  await page.getByRole('button', { name: 'Last seen' }).click();   // oldest first: never seen on top
  assert.deepEqual(await nums(), ['15', '7', '42']);
  if (process.env.SHOTS) await page.screenshot({ path: 'tmp/activity-riders.png' });

  await page.getByRole('button', { name: 'Scorers', exact: true }).click();
  assert.ok(await page.getByRole('cell', { name: 'scorer@example.com' }).isVisible());
  assert.deepEqual(errors, []);
});

test('scorer: signed-out user gets the email login; non-scorer is told so', async () => {
  const { page } = await newPage({});
  await page.goto(`${APP}scorer.html`);
  await page.getByText('Scorer sign in').waitFor();

  const other = await newPage({ 'POST /rest/v1/rpc/staff_role': () => ({ json: null }) }, { session: true });
  await other.page.goto(`${APP}scorer.html`);
  await other.page.getByText('is not on the scorer list').waitFor();
});

test('admin: CSV import validates, then upserts riders with the sheet column names', async () => {
  const { page, calls, errors } = await newPage({
    'POST /rest/v1/rpc/staff_role': () => ({ json: 'admin' }),
    'GET /rest/v1/settings': () => ({ json: { id: 1, event_name: 'SNAFU Test Rally', max_attempts: 3, claims_open: true } }),
    'GET /rest/v1/riders': () => ({ json: [{ rider_number: 42, name: 'Jane Smith', email: 'jane@example.com', token: TOKEN }] }),
    'POST /rest/v1/riders': () => ({ status: 201, json: [] }),
    'POST /rest/v1/bonuses': () => ({ status: 201, json: [] }),
  }, { session: true });
  await page.goto(`${APP}admin.html`);
  await page.locator('#riders tbody a').waitFor();
  assert.equal(await page.inputValue('#s-name'), 'SNAFU Test Rally');
  assert.match(await page.getAttribute('#riders tbody a', 'href'), new RegExp(`rider\\.html\\?t=${TOKEN}$`));
  assert.deepEqual(await navLinks(page), ['Review', 'Activity', 'Admin', 'Leader board']);

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
  assert.deepEqual(await navLinks(page), [], 'the public sees no staff links');
  assert.deepEqual(errors, []);

  // A signed-in scorer gets links back to their pages
  const signedIn = await newPage({
    'POST /rest/v1/rpc/leaderboard': () => ({ json: [] }),
    'POST /rest/v1/rpc/staff_role': () => ({ json: 'scorer' }),
  }, { session: true });
  await signedIn.page.goto(`${APP}leaderboard.html`);
  await signedIn.page.locator('nav.nav').waitFor();
  assert.deepEqual(await navLinks(signedIn.page), ['Review', 'Activity', 'Leader board']);
});

test('rider: reference photo shows on tap', async () => {
  const { page, calls, errors } = await newPage({
    'POST /rest/v1/rpc/rider_session': () => ({ json: session() }),
    'GET /storage/v1/object/public/bonus-photos/': servePng,
  });
  await page.goto(`${APP}rider.html?t=${TOKEN}`);
  await page.getByRole('button', { name: /WXYZ/ }).click();
  assert.equal(await page.isVisible('#c-ref'), false, 'no button when the bonus has no reference photo');
  await page.getByRole('button', { name: /All bonuses/ }).click();
  await page.getByRole('button', { name: /ABCD/ }).click();
  assert.equal(calls.filter((c) => c.key.includes('bonus-photos')).length, 0, 'nothing downloaded before the tap');
  await page.getByRole('button', { name: 'Show reference photo' }).click();
  await page.waitForFunction(() => document.querySelector('#c-ref-img').naturalWidth > 0);
  assert.equal(await page.getAttribute('#c-ref-img', 'src'), `${API}/storage/v1/object/public/bonus-photos/ABCD/ref.jpg`);
  await page.getByRole('button', { name: 'Hide reference photo' }).click();
  assert.equal(await page.isVisible('#c-ref-img'), false);
  assert.deepEqual(errors, []);
});

test('scorer: claim dialog shows the submitted and reference photos and decides from there', async () => {
  const claim = (id, code, ref) => ({
    id, status: 'pending', bonus_code: code, bonus_name: `Bonus ${code}`, points: 10, bonus_is_combo: false,
    rider_number: 42, rider_name: 'Jane Smith', submitted_at: new Date().toISOString(), submitted_by: 'rider 42',
    photo_path: `${TOKEN}/${id}.jpg`, bonus_ref_photo: ref });
  const { page, calls, errors } = await newPage({
    'POST /rest/v1/rpc/staff_role': () => ({ json: 'scorer' }),
    'GET /rest/v1/bonuses': () => ({ json: [] }),
    'HEAD /rest/v1/claims': () => ({ headers: { 'content-range': '0-1/2' } }),
    'GET /rest/v1/claims_detail': () => ({ json: [claim('c1', 'ABCD', 'ABCD/ref.jpg'), claim('c2', 'WXYZ', null)] }),
    'POST /storage/v1/object/sign/claims': (c) => ({ json: c.json.paths.map((p) => ({ path: p, signedURL: `/object/sign/claims/${p}?token=t`, error: null })) }),
    'GET /storage/v1/object/': servePng,
    'POST /rest/v1/rpc/scorer_decide': () => ({ json: { id: 'c1', status: 'denied' } }),
  }, { session: true });
  await page.goto(`${APP}scorer.html`);
  await page.locator('.claim').first().waitFor();

  await page.locator('.claim', { hasText: 'WXYZ' }).locator('img').click();
  const dlg = page.locator('#claim-dlg');
  await dlg.waitFor();
  assert.ok(await dlg.getByText('No reference photo for this bonus').isVisible());
  await dlg.getByRole('button', { name: 'Close' }).click();
  await dlg.waitFor({ state: 'hidden' });

  await page.locator('.claim', { hasText: 'ABCD' }).getByRole('button', { name: /ABCD/ }).click();
  assert.match(await dlg.getByRole('img', { name: 'Submitted photo for ABCD' }).getAttribute('src'), /object\/sign\/claims\/.*c1\.jpg/);
  assert.equal(await dlg.getByRole('img', { name: 'Reference photo for ABCD' }).getAttribute('src'),
    `${API}/storage/v1/object/public/bonus-photos/ABCD/ref.jpg`);
  if (process.env.SHOTS) { await page.setViewportSize({ width: 1100, height: 760 }); await page.screenshot({ path: 'tmp/scorer-dialog.png' }); }

  await dlg.getByRole('button', { name: 'Deny' }).click();
  await dlg.getByText('Enter a reason to deny.').waitFor();
  await dlg.getByRole('textbox').fill('not the mill');
  await dlg.getByRole('button', { name: 'Deny' }).click();
  await dlg.waitFor({ state: 'hidden' });
  assert.deepEqual(calls.find((c) => c.key.includes('scorer_decide')).json,
    { p_claim_id: 'c1', p_status: 'denied', p_reason: 'not the mill' });
  assert.deepEqual(errors, []);
});

test('admin page is for admins only', async () => {
  const { page } = await newPage({ 'POST /rest/v1/rpc/staff_role': () => ({ json: 'scorer' }) }, { session: true });
  await page.goto(`${APP}admin.html`);
  await page.getByText('for rally admins only').waitFor();
  assert.deepEqual(await navLinks(page), ['Review', 'Activity', 'Leader board']);
  assert.equal(await page.locator('#settings').count(), 0);
});

test('admin: edit riders, bonuses with a reference photo, combos; delete all', async () => {
  const { page, calls, errors } = await newPage({
    'POST /rest/v1/rpc/staff_role': () => ({ json: 'admin' }),
    'GET /rest/v1/settings': () => ({ json: { id: 1, event_name: 'SNAFU Test Rally', max_attempts: 3, claims_open: true } }),
    'GET /rest/v1/riders': () => ({ json: [{ id: 1, rider_number: 42, name: 'Jane Smith', email: 'jane@example.com', token: TOKEN }] }),
    'GET /rest/v1/bonuses': () => ({ json: [
      { code: 'ABCD', name: 'Old mill', points: 100, sort_order: 1, description: null, ref_photo_path: null },
      { code: 'WXYZ', name: 'Covered bridge', points: 50, sort_order: 2, description: null, ref_photo_path: 'WXYZ/old.jpg' },
      { code: 'ARSN', name: 'Mill + bridge', points: 25, sort_order: 3, description: null, ref_photo_path: null }] }),
    'GET /rest/v1/combo_members': () => ({ json: [{ combo_code: 'ARSN', member_code: 'ABCD' }, { combo_code: 'ARSN', member_code: 'WXYZ' }] }),
    'GET /storage/v1/object/public/bonus-photos/': servePng,
    'PATCH /rest/v1/riders': () => ({ status: 204 }),
    'PATCH /rest/v1/bonuses': () => ({ status: 204 }),
    'POST /rest/v1/bonuses': () => ({ status: 201 }),
    'DELETE /rest/v1/bonuses': () => ({ status: 409, json: { code: '23503', message: 'update or delete on table "bonuses" violates foreign key constraint' } }),
    'POST /storage/v1/object/bonus-photos/': () => ({ json: { Key: 'bonus-photos/x' } }),
    'DELETE /storage/v1/object/bonus-photos': () => ({ json: [] }),
    'POST /rest/v1/rpc/admin_set_combo': () => ({ json: 3 }),
    'POST /rest/v1/rpc/admin_delete_all': () => ({ json: 1 }),
  }, { session: true });
  page.on('dialog', (d) => d.accept());   // "Are you sure?" prompts
  await page.goto(`${APP}admin.html`);
  await page.locator('#combos tbody', { hasText: 'ABCD, WXYZ' }).waitFor();
  const edit = page.locator('#edit');

  // Rider: edit the name
  await page.click('[data-edit-rider="1"]');
  await edit.locator('#f-name').fill('Jane Q Smith');
  await edit.getByRole('button', { name: 'Save' }).click();
  await edit.waitFor({ state: 'hidden' });
  const pr = calls.find((c) => c.key === 'PATCH /rest/v1/riders');
  assert.equal(pr.url.searchParams.get('id'), 'eq.1');
  assert.deepEqual(pr.json, { rider_number: 42, name: 'Jane Q Smith', email: 'jane@example.com' });

  // Bonus: replace the reference photo (shrunk, uploaded, old file removed)
  await page.click('[data-edit-bonus="WXYZ"]');
  assert.equal(await edit.locator('#f-code').getAttribute('readonly'), '');
  await edit.locator('#f-photo').setInputFiles({ name: 'ref.png', mimeType: 'image/png', buffer: PNG });
  await edit.getByRole('button', { name: 'Save' }).click();
  await edit.waitFor({ state: 'hidden' });
  const up = calls.find((c) => c.key.startsWith('POST /storage/v1/object/bonus-photos/'));
  assert.match(up.key, /bonus-photos\/WXYZ\/[0-9a-f-]{36}\.jpg$/);
  const pb = calls.find((c) => c.key === 'PATCH /rest/v1/bonuses');
  assert.equal(pb.url.searchParams.get('code'), 'eq.WXYZ');
  assert.equal(pb.json.ref_photo_path, up.key.replace('POST /storage/v1/object/bonus-photos/', ''));
  assert.deepEqual((await callMade(page, calls, (c) => c.key === 'DELETE /storage/v1/object/bonus-photos')).json, { prefixes: ['WXYZ/old.jpg'] });

  // Bonus: add one; the code is checked first
  await page.click('[data-add="bonus"]');
  await edit.locator('#f-code').fill('ab12');
  await edit.locator('#f-points').fill('5');
  await edit.getByRole('button', { name: 'Save' }).click();
  await edit.getByText('"AB12" is not 4 letters').waitFor();
  await edit.locator('#f-code').fill('new1');
  await edit.getByRole('button', { name: 'Save' }).click();
  await edit.waitFor({ state: 'hidden' });
  assert.deepEqual(calls.find((c) => c.key === 'POST /rest/v1/bonuses').json,
    { code: 'NEW1', name: null, points: 5, description: null, sort_order: null });

  // Bonus with claims cannot be deleted; the message says why
  await page.click('[data-del-bonus="ABCD"]');
  await page.locator('#bonuses-msg', { hasText: 'Bonus ABCD has claims' }).waitFor();

  // Combo: members typed in any case, commas or spaces
  await page.click('[data-edit-combo="ARSN"]');
  await edit.locator('#f-members').fill('abcd wxyz, abc1');
  await edit.getByRole('button', { name: 'Save' }).click();
  await edit.waitFor({ state: 'hidden' });
  assert.deepEqual(calls.find((c) => c.key === 'POST /rest/v1/rpc/admin_set_combo').json,
    { p_combo: 'ARSN', p_members: ['ABCD', 'WXYZ', 'ABC1'] });

  // Delete all riders
  await page.selectOption('#del-what', 'riders');
  assert.equal(await page.getAttribute('#del-confirm', 'placeholder'), 'Type DELETE ALL RIDERS');
  await page.fill('#del-confirm', 'DELETE ALL RIDERS');
  await page.getByRole('button', { name: 'Delete all riders' }).click();
  await page.getByText('Deleted 1 rider.').waitFor();
  assert.deepEqual(calls.find((c) => c.key === 'POST /rest/v1/rpc/admin_delete_all').json,
    { p_what: 'riders', p_confirm: 'DELETE ALL RIDERS' });
  if (process.env.SHOTS) { await page.setViewportSize({ width: 1200, height: 900 }); await page.screenshot({ path: 'tmp/admin.png', fullPage: true }); }
  assert.deepEqual(errors, []);
});
