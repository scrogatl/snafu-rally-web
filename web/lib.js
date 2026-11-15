// Shared helpers for every page.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const configured = !SUPABASE_URL.includes('YOUR-PROJECT-REF') && !SUPABASE_ANON_KEY.startsWith('YOUR-');
export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, detectSessionInUrl: true },
});
export const BUCKET = 'claims';

export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtTime(v) {
  if (!v) return '';
  const d = new Date(v);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Turn Supabase / network errors into a sentence a rider can act on
export function errorText(err) {
  const msg = err?.message || String(err || 'Unknown error');
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) {
    return 'No signal or the server could not be reached. Your entry is kept - try again when you have coverage.';
  }
  return msg;
}

export function showMessage(el, text, kind = 'info') {
  el.className = `msg ${kind}`;
  el.textContent = text;
  el.hidden = !text;
}

export function setupBanner() {
  if (configured) return;
  const div = document.createElement('div');
  div.className = 'msg error';
  div.textContent = 'Setup needed: open web/config.js and fill in SUPABASE_URL and SUPABASE_ANON_KEY.';
  document.body.prepend(div);
}

// Shrink a photo on the phone before upload. Falls back to the original file
// if this browser cannot decode it (some HEIC files on Android).
export async function shrinkImage(file, maxEdge = 1600, quality = 0.8) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) throw new Error('Could not encode image');
    return { blob, ext: 'jpg', type: 'image/jpeg', shrunk: true };
  } catch (e) {
    console.warn('Shrink skipped, uploading original:', e);
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    return { blob: file, ext, type: file.type || 'image/jpeg', shrunk: false };
  }
}

// randomUUID only exists on https pages; fall back so plain-http local testing works too
export const newId = () => (crypto.randomUUID ? crypto.randomUUID()
  : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
      (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));

// Scorer login helpers
export async function currentScorer() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return { session: null, isScorer: false };
  const { data, error } = await sb.rpc('is_scorer');
  if (error) throw error;
  return { session, isScorer: data === true };
}

export function renderLogin(container, onDone) {
  container.innerHTML = `
    <div class="card">
      <h2>Scorer sign in</h2>
      <p>Enter your email. We will send you a sign-in link.</p>
      <form id="login-form" class="stack">
        <input type="email" id="login-email" required placeholder="you@example.com" autocomplete="email">
        <button type="submit">Email me a link</button>
      </form>
      <div id="login-msg" class="msg" hidden></div>
    </div>`;
  $('#login-form', container).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = $('#login-email', container).value.trim().toLowerCase();
    const msg = $('#login-msg', container);
    showMessage(msg, 'Sending...');
    const redirect = location.href.split('#')[0];
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect } });
    if (error) showMessage(msg, errorText(error), 'error');
    else showMessage(msg, `Check ${email} for the sign-in link. Open it on this device.`, 'ok');
  });
  sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_IN') onDone?.(); });
}

export function navBar(active) {
  const links = [['scorer.html', 'Review'], ['activity.html', 'Activity'], ['admin.html', 'Admin'],
    ['leaderboard.html', 'Leader board']];
  return `<nav class="nav">${links.map(([href, label]) =>
    `<a href="${href}" class="${active === href ? 'active' : ''}">${label}</a>`).join('')}
    <button type="button" class="link" id="sign-out">Sign out</button></nav>`;
}

export function wireSignOut() {
  const b = document.getElementById('sign-out');
  if (b) b.addEventListener('click', async () => { await sb.auth.signOut(); location.reload(); });
}

// Read / write a small remembered choice; storage can be blocked (private mode), so never throw
export function remember(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
}
export function keep(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
}

// Sortable table. Click a header to sort; click again to reverse. The choice is remembered.
//   cols: [{ key, label, num (right-align), desc (first click sorts high-to-low),
//            value(row) -> sort value (default row[key]), cell(row) -> HTML (default escaped value),
//            cls (extra cell class, e.g. 'wrap'), nosort }]
//   opts: { sort: { key, dir: 'asc' | 'desc' }, store: localStorage key, empty: text, rowClass(row) }
// Empty values sort as the smallest, so ascending shows blanks (like "never seen") first.
// Returns { set(rows) } to (re)draw with new rows.
export function sortableTable(el, cols, opts = {}) {
  let rows = [];
  let sort = (opts.store && remember(opts.store, null)) || opts.sort || { key: cols[0].key, dir: 'asc' };
  if (!cols.some((c) => c.key === sort.key)) sort = opts.sort || { key: cols[0].key, dir: 'asc' };
  const valueOf = (c, r) => (c.value ? c.value(r) : r[c.key]);
  const blank = (v) => v === null || v === undefined || v === '';
  const cmp = (a, b) => {
    if (blank(a) || blank(b)) return blank(a) && blank(b) ? 0 : blank(a) ? -1 : 1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  };
  function draw() {
    const col = cols.find((c) => c.key === sort.key);
    const sorted = col ? rows.map((r, i) => [r, i]).sort(([a, i], [b, j]) =>
      (cmp(valueOf(col, a), valueOf(col, b)) * (sort.dir === 'desc' ? -1 : 1)) || i - j).map(([r]) => r) : rows;
    const head = cols.map((c) => {
      const aria = c.key === sort.key ? ` aria-sort="${sort.dir === 'asc' ? 'ascending' : 'descending'}"` : '';
      const label = c.nosort ? esc(c.label) : `<button type="button" class="th-sort" data-sort="${esc(c.key)}">${esc(c.label)}</button>`;
      return `<th class="${c.num ? 'num' : ''}"${aria}>${label}</th>`;
    }).join('');
    const body = sorted.map((r) => `<tr class="${opts.rowClass ? esc(opts.rowClass(r) || '') : ''}">${cols.map((c) =>
      `<td class="${c.num ? 'num' : ''} ${c.cls || ''}">${c.cell ? c.cell(r) : esc(valueOf(c, r))}</td>`).join('')}</tr>`).join('');
    el.innerHTML = `<div class="table-wrap"><table class="data"><thead><tr>${head}</tr></thead><tbody>${
      body || `<tr><td colspan="${cols.length}" class="muted">${esc(opts.empty || 'Nothing to show.')}</td></tr>`}</tbody></table></div>`;
  }
  el.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-sort]');
    if (!b || !el.contains(b)) return;
    const col = cols.find((c) => c.key === b.dataset.sort);
    sort = sort.key === col.key ? { key: col.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
      : { key: col.key, dir: col.desc ? 'desc' : 'asc' };
    if (opts.store) keep(opts.store, sort);
    draw();
  });
  return { set(r) { rows = r || []; draw(); } };
}
