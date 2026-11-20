// Security tests: who can read and change what, rider isolation, photo paths, secrets, and HTML escaping.
// Run: npm run test:security   (part of npm test)
//
// Part 1 runs the real supabase/schema.sql in PGlite and checks the rules from the database catalog
// (so a new table, view or function that is left open fails here) and by trying each attack as each role:
//   anon      = anyone with the public anon key (riders, the public)
//   stranger  = signed in with an email that is not on the scorer list
//   scorer    = on the scorer list, not an admin
//   admin     = scorer with is_admin
// Part 2 checks committed files (no secret keys, pinned CDN scripts) and the Netlify config script.
// Part 3 loads every page in Chromium with hostile data and checks nothing runs.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { APP, TOKEN, newPage, useBrowser, root } from './browser.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const SCORER = 'scorer@example.com';
const ADMIN = 'admin@example.com';
const STRANGER = 'stranger@example.com';
let db, tokenA, tokenB;

async function as(role, email, fn) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify(email ? { email, role } : { role })]);
    await tx.exec(`set local role ${role}`);
    return fn(tx);
  });
}
const anon = (fn) => as('anon', null, fn);
const stranger = (fn) => as('authenticated', STRANGER, fn);
const scorer = (fn) => as('authenticated', SCORER, fn);
const admin = (fn) => as('authenticated', ADMIN, fn);
const one = async (tx, sql, params) => (await tx.query(sql, params)).rows[0];
const rows = async (q, sql, params) => (await q((tx) => tx.query(sql, params))).rows;
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });
const uuid = () => crypto.randomUUID();
const submit = (token, code, path, cid = uuid(), note = null) =>
  anon((tx) => tx.query('select rider_submit($1,$2,$3,$4,$5,null) r', [token, cid, code, path, note]));

before(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(read('./supabase_stubs.sql'));
  await db.exec(read('../supabase/schema.sql'));
  await db.exec(`
    insert into scorers (email, is_admin) values ('${SCORER}', false), ('${ADMIN}', true);
    insert into riders (rider_number, name, email) values (1, 'Alice Rider', 'alice@example.com'), (2, 'Bob Rider', 'bob@example.com');
    insert into bonuses (code, name, points) values
      ('ABCD', 'Old mill', 100), ('WXYZ', 'Covered bridge', 50), ('ARSN', 'Combo', 25), ('LAT1', 'Late', -25);
    insert into combo_members values ('ARSN', 'ABCD'), ('ARSN', 'WXYZ');
  `);
  tokenA = (await db.query(`select token from riders where rider_number = 1`)).rows[0].token;
  tokenB = (await db.query(`select token from riders where rider_number = 2`)).rows[0].token;
});

// ---------------------------------------------------------------------------
// Part 1a: catalog checks (catch anything new that is left open)
// ---------------------------------------------------------------------------

// Functions each role may call. Anything else in schema public must be closed to them.
const ANON_FUNCTIONS = ['current_email', 'is_admin', 'is_combo', 'is_scorer', 'leaderboard', 'rider_session',
  'rider_submit', 'rider_token_valid', 'staff_role'];
const AUTH_FUNCTIONS = [...ANON_FUNCTIONS, 'admin_delete_all', 'admin_set_combo', 'require_admin', 'require_scorer',
  'scorer_add_claim', 'scorer_decide', 'scorer_delete_all_claims', 'scorer_list', 'scorer_new_token'].sort();

// Table / view commands the signed-in role may try (RLS still decides which rows)
const AUTH_TABLES = {
  settings: 'SELECT,INSERT,UPDATE,DELETE', riders: 'SELECT,INSERT,UPDATE,DELETE',
  bonuses: 'SELECT,INSERT,UPDATE,DELETE', combo_members: 'SELECT,INSERT,UPDATE,DELETE',
  scorers: 'SELECT', claims: 'SELECT', claim_events: 'SELECT',
  approved_direct: 'SELECT', approved_effective: 'SELECT', rider_scores: 'SELECT', claims_detail: 'SELECT',
  claim_activity: 'SELECT', rider_activity: 'SELECT',
};
const ALL_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

const ourFunctions = async () => (await db.query(`
  select p.oid, p.proname, p.prosecdef, p.proconfig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')  -- skip extension functions
  order by p.proname`)).rows;

test('catalog: anon and signed-in users can call only the listed functions', async () => {
  const can = async (role) => (await db.query(`
    select distinct p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege($1, p.oid, 'execute')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    order by 1`, [role])).rows.map((r) => r.proname);
  assert.deepEqual(await can('anon'), ANON_FUNCTIONS);
  assert.deepEqual(await can('authenticated'), AUTH_FUNCTIONS);
  // Internal helpers and the Edge Function lookup stay closed
  for (const f of ['rider_from_token', 'rider_photo_paths', 'claims_before_write', 'claims_after_write']) {
    assert.ok(!(await can('anon')).includes(f) && !(await can('authenticated')).includes(f), f);
  }
});

test('catalog: every security definer function pins its search_path', async () => {
  const definer = (await ourFunctions()).filter((f) => f.prosecdef);
  assert.ok(definer.length >= 15);
  const loose = definer.filter((f) => !(f.proconfig || []).some((c) => c.startsWith('search_path=')));
  assert.deepEqual(loose.map((f) => f.proname), []);
});

test('catalog: every table has row level security; every view runs as the caller', async () => {
  const tables = (await db.query(`
    select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'`)).rows;
  assert.ok(tables.length >= 7);
  assert.deepEqual(tables.filter((t) => !t.relrowsecurity).map((t) => t.relname), []);

  const views = (await db.query(`
    select c.relname, coalesce(c.reloptions, '{}') opts from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'`)).rows;
  assert.ok(views.length >= 6);
  assert.deepEqual(views.filter((v) => !v.opts.includes('security_invoker=true')).map((v) => v.relname), []);
});

test('catalog: anon has no table access; signed-in users only the listed commands, never TRUNCATE', async () => {
  const rels = (await db.query(`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'v') order by 1`)).rows.map((r) => r.relname);
  assert.deepEqual(rels, Object.keys(AUTH_TABLES).sort(), 'a new table or view needs a decision here');
  for (const rel of rels) {
    for (const priv of ALL_PRIVS) {
      const q = `select has_table_privilege($1, 'public.' || $2, $3) ok`;
      assert.equal((await db.query(q, ['anon', rel, priv])).rows[0].ok, false, `anon ${priv} on ${rel}`);
      const expected = AUTH_TABLES[rel].split(',').includes(priv);
      assert.equal((await db.query(q, ['authenticated', rel, priv])).rows[0].ok, expected, `authenticated ${priv} on ${rel}`);
    }
  }
});

test('catalog: policies are for signed-in users only; storage has exactly the expected rules', async () => {
  const pub = (await db.query(`select tablename, policyname, roles::text[] roles from pg_policies where schemaname = 'public'`)).rows;
  assert.deepEqual(pub.filter((p) => p.roles.join() !== 'authenticated').map((p) => `${p.tablename}.${p.policyname}`), []);

  const storage = (await db.query(`
    select policyname, cmd, roles::text[] roles from pg_policies where schemaname = 'storage' order by 1`)).rows;
  assert.deepEqual(storage.map((p) => `${p.policyname} ${p.cmd} ${p.roles.join('+')}`), [
    'admin_ref_delete DELETE authenticated',
    'admin_ref_insert INSERT authenticated',
    'admin_ref_read SELECT authenticated',
    'rider_upload INSERT anon+authenticated',
    'scorer_read_photos SELECT authenticated',
    'scorer_upload INSERT authenticated',
  ]);
  const buckets = (await db.query(`select id, public from storage.buckets order by id`)).rows;
  assert.deepEqual(buckets, [{ id: 'bonus-photos', public: true }, { id: 'claims', public: false }]);
});

// ---------------------------------------------------------------------------
// Part 1b: trying it as each role
// ---------------------------------------------------------------------------
const TABLES = ['settings', 'scorers', 'riders', 'bonuses', 'combo_members', 'claims', 'claim_events'];
const VIEWS = ['approved_direct', 'approved_effective', 'rider_scores', 'claims_detail', 'claim_activity', 'rider_activity'];

test('anon key: cannot read or write any table or view', async () => {
  for (const t of [...TABLES, ...VIEWS]) {
    await rejects(anon((tx) => tx.query(`select * from ${t}`)), /permission denied/);
  }
  for (const sql of [
    `insert into riders (rider_number, name) values (99, 'x')`, `update riders set name = 'x'`, `delete from riders`,
    `update settings set claims_open = false`, `insert into scorers (email, is_admin) values ('me@x.com', true)`,
    `insert into claims (rider_id, bonus_code, status) values (1, 'ABCD', 'approved')`, `delete from claims`,
    `truncate claims`, `delete from claim_events`,
  ]) {
    await rejects(anon((tx) => tx.query(sql)), /permission denied/, sql);
  }
});

test('anon key: cannot call scorer or admin functions, even with an admin email in the claims', async () => {
  // A real anon key carries no email; this checks the grants hold even if one did
  const fake = (fn) => as('anon', ADMIN, fn);
  for (const q of [anon, fake]) {
    for (const sql of [
      `select scorer_decide('${uuid()}', 'approved')`, `select scorer_add_claim(1, 'ABCD', 'approved')`,
      `select scorer_new_token(1)`, `select scorer_delete_all_claims('DELETE ALL CLAIMS')`, `select * from scorer_list()`,
      `select admin_delete_all('riders', 'DELETE ALL RIDERS')`, `select admin_set_combo('ARSN', array['ABCD','WXYZ'])`,
      `select rider_photo_paths('${tokenA}')`, `select rider_from_token('${tokenA}')`,
    ]) {
      await rejects(q((tx) => tx.query(sql)), /permission denied/, sql);
    }
    await rejects(q((tx) => tx.query(`select * from riders`)), /permission denied/);
  }
});

test('signed in but not a scorer: sees nothing, changes nothing', async () => {
  for (const t of [...TABLES, ...VIEWS]) {
    assert.equal((await rows(stranger, `select * from ${t}`)).length, 0, t);
  }
  await rejects(stranger((tx) => tx.query(`insert into riders (rider_number, name) values (99, 'x')`)), /row-level security/);
  await rejects(stranger((tx) => tx.query(`insert into bonuses (code, points) values ('EVIL', 1000)`)), /row-level security/);
  for (const sql of [`update riders set name = 'x'`, `delete from riders`, `update bonuses set points = 1000`,
    `update settings set claims_open = false`, `delete from combo_members`]) {
    assert.equal((await stranger((tx) => tx.query(sql))).affectedRows, 0, sql);
  }
  for (const sql of [`select scorer_decide('${uuid()}', 'approved')`, `select scorer_add_claim(1, 'ABCD', 'approved')`,
    `select * from scorer_list()`]) {
    await rejects(stranger((tx) => tx.query(sql)), /Not authorized. Your email is not on the scorer list/, sql);
  }
  for (const sql of [`select scorer_new_token(1)`, `select admin_delete_all('riders', 'DELETE ALL RIDERS')`,
    `select admin_set_combo('ARSN', array['ABCD','WXYZ'])`, `select scorer_delete_all_claims('DELETE ALL CLAIMS')`]) {
    await rejects(stranger((tx) => tx.query(sql)), /Only rally admins/, sql);
  }
  assert.equal(await stranger((tx) => one(tx, 'select staff_role() r')).then((r) => r.r), null);
});

test('scorer: cannot make themselves an admin or add scorers', async () => {
  await rejects(scorer((tx) => tx.query(`update scorers set is_admin = true where email = '${SCORER}'`)), /permission denied/);
  await rejects(scorer((tx) => tx.query(`insert into scorers (email, is_admin) values ('friend@example.com', true)`)), /permission denied/);
  await rejects(scorer((tx) => tx.query(`delete from scorers`)), /permission denied/);
  // Admins cannot change the scorer list from the pages either (only the SQL Editor can)
  await rejects(admin((tx) => tx.query(`insert into scorers (email) values ('friend@example.com')`)), /permission denied/);
  assert.equal((await db.query(`select is_admin from scorers where email = '${SCORER}'`)).rows[0].is_admin, false);
});

test('scorer: cannot change the event setup', async () => {
  await rejects(scorer((tx) => tx.query(`insert into riders (rider_number, name) values (99, 'x')`)), /row-level security/);
  await rejects(scorer((tx) => tx.query(`insert into bonuses (code, points) values ('EVIL', 1000)`)), /row-level security/);
  await rejects(scorer((tx) => tx.query(`insert into combo_members values ('ABCD', 'WXYZ')`)), /row-level security/);
  for (const sql of [`update riders set token = gen_random_uuid()`, `delete from riders`, `update bonuses set points = 1000`,
    `delete from bonuses`, `update settings set max_attempts = 10`, `delete from combo_members`]) {
    assert.equal((await scorer((tx) => tx.query(sql))).affectedRows, 0, sql);
  }
  for (const sql of [`select scorer_new_token(1)`, `select admin_delete_all('bonuses', 'DELETE ALL BONUSES')`,
    `select admin_set_combo('ARSN', '{}')`, `select scorer_delete_all_claims('DELETE ALL CLAIMS')`]) {
    await rejects(scorer((tx) => tx.query(sql)), /Only rally admins/, sql);
  }
});

test('scorers and admins: claims and the audit log change only through the functions', async () => {
  await submit(tokenA, 'ABCD', `${tokenA}/${uuid()}.jpg`);
  const claim = (await db.query(`select id from claims limit 1`)).rows[0].id;
  for (const q of [scorer, admin]) {
    for (const sql of [
      `insert into claims (rider_id, bonus_code, status) select id, 'WXYZ', 'approved' from riders limit 1`,
      `update claims set status = 'approved' where id = '${claim}'`,
      `delete from claims where id = '${claim}'`,
      `insert into claim_events (claim_id, action, to_status, actor) values ('${claim}', 'approved', 'approved', 'someone')`,
      `update claim_events set actor = 'someone else'`, `delete from claim_events`, `truncate claim_events`,
    ]) {
      await rejects(q((tx) => tx.query(sql)), /permission denied/, sql);
    }
  }
  // The decision is logged with the signed-in email, whatever the claim says
  await scorer((tx) => tx.query(`select scorer_decide($1, 'denied', 'blurry')`, [claim]));
  const e = (await db.query(`select actor from claim_events where claim_id = $1 and action = 'denied'`, [claim])).rows[0];
  assert.equal(e.actor, SCORER);
});

test('riders: one rider link cannot act for, or see, another rider', async () => {
  // Another rider's photo, or a path that climbs out of the rider's own folder
  for (const path of [`${tokenB}/${uuid()}.jpg`, `${tokenA}/../${tokenB}/${uuid()}.jpg`, `${tokenA}/x/../../${tokenB}/a.jpg`,
    `${tokenA}/sub/${uuid()}.jpg`, `${tokenA}/`, `/${tokenA}/${uuid()}.jpg`, `scorer/${uuid()}.jpg`]) {
    await rejects(submit(tokenA, 'WXYZ', path), /Photo does not belong to this rider/, path);
  }
  // Reusing another rider's submission id does not reveal or touch their claim
  const cid = uuid();
  await submit(tokenB, 'WXYZ', `${tokenB}/${cid}.jpg`, cid);
  await rejects(submit(tokenA, 'WXYZ', `${tokenA}/${cid}.jpg`, cid), /Duplicate submission id/);

  // Rider A's page data has nothing about rider B, no emails, no penalties. (Rider A's own token does
  // appear, in the paths of A's own photos; A already has it.)
  const s = JSON.stringify((await anon((tx) => one(tx, 'select rider_session($1) s', [tokenA]))).s);
  for (const secret of [tokenB, 'Bob Rider', 'bob@example.com', 'alice@example.com', 'LAT1', SCORER, ADMIN]) {
    assert.ok(!s.includes(secret), `rider session leaks ${secret}`);
  }
  // Leader board shows only rank, number, name, score, count
  const board = (await anon((tx) => tx.query('select * from leaderboard()')));
  assert.deepEqual(board.fields.map((f) => f.name), ['finish', 'rider_number', 'name', 'score', 'bonuses_counted']);
  assert.ok(!JSON.stringify(board.rows).includes(tokenA));
});

test('riders: a made-up or old link gets nowhere', async () => {
  await rejects(anon((tx) => tx.query('select rider_session($1)', [uuid()])), /rider link is not valid/);
  await rejects(submit(uuid(), 'ABCD', null), /rider link is not valid/);
  for (const t of ['', 'x', '../', `${tokenA}' or '1'='1`, 'scorer']) {
    assert.equal((await anon((tx) => one(tx, 'select rider_token_valid($1) ok', [t]))).ok, false, t);
  }
  // A new link from the admin kills the old one at once
  const old = tokenB;
  const fresh = (await admin((tx) => one(tx, 'select scorer_new_token(2) t'))).t;
  await rejects(anon((tx) => tx.query('select rider_session($1)', [old])), /rider link is not valid/);
  assert.equal((await anon((tx) => one(tx, 'select rider_session($1) s', [fresh]))).s.rider.number, 2);
  tokenB = fresh;
});

test('riders: hostile input is data, not commands; limits hold', async () => {
  await rejects(submit(tokenA, `ABCD'; delete from claims; --`, null), /Unknown bonus code/);
  await rejects(submit(tokenA, 'LAT1', `${tokenA}/${uuid()}.jpg`), /Unknown bonus code LAT1/);   // no claiming penalties
  await rejects(submit(tokenA, 'ABCD', `${tokenA}/${uuid()}.jpg`, uuid(), 'x'.repeat(501)), /check constraint/);
  const c = (await scorer((tx) => one(tx, `select * from scorer_add_claim(1, 'WXYZ', 'pending')`)));
  await rejects(scorer((tx) => tx.query(`select scorer_decide($1, 'denied', $2)`, [c.id, 'x'.repeat(501)])), /check constraint/);
  assert.ok((await db.query('select count(*)::int n from claims')).rows[0].n > 0, 'claims still there');
});

test('storage: riders upload only into their own folder; nobody but staff can read or list', async () => {
  const put = (q, bucket, name) => q((tx) => tx.query(`insert into storage.objects (bucket_id, name) values ($1, $2)`, [bucket, name]));
  await put(anon, 'claims', `${tokenA}/${uuid()}.jpg`);   // the normal rider upload works
  for (const name of [`${uuid()}/x.jpg`, `scorer/x.jpg`, `${tokenA}/../${tokenB}/x.jpg`, `${tokenA}/a/b.jpg`,
    `x.jpg`, `../${tokenA}/x.jpg`]) {
    await rejects(put(anon, 'claims', name), /row-level security/, name);
  }
  await rejects(put(anon, 'bonus-photos', `ABCD/${uuid()}.jpg`), /row-level security/);
  await rejects(put(stranger, 'claims', `scorer/${uuid()}.jpg`), /row-level security/);
  await rejects(put(stranger, 'bonus-photos', `ABCD/${uuid()}.jpg`), /row-level security/);
  await rejects(put(scorer, 'bonus-photos', `ABCD/${uuid()}.jpg`), /row-level security/);
  await put(scorer, 'claims', `scorer/${uuid()}.jpg`);
  await put(admin, 'bonus-photos', `ABCD/${uuid()}.jpg`);

  // Listing would reveal rider folder names, which are their link tokens
  assert.equal((await rows(anon, 'select * from storage.objects')).length, 0);
  assert.equal((await rows(stranger, 'select * from storage.objects')).length, 0);
  assert.equal((await rows(scorer, `select * from storage.objects where bucket_id = 'bonus-photos'`)).length, 0);
  assert.ok((await rows(scorer, `select * from storage.objects where bucket_id = 'claims'`)).length >= 2);
  assert.equal((await rows(admin, `select * from storage.objects where bucket_id = 'bonus-photos'`)).length, 1);
});

// ---------------------------------------------------------------------------
// Part 2: committed files and the Netlify config script
// ---------------------------------------------------------------------------
const repoFiles = () => execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n')
  .filter((f) => f && !/\.(png|jpe?g|gif|ico|lock)$/.test(f) && f !== 'package-lock.json');
const jwtRole = (t) => { try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).role; } catch { return null; } };

test('files: no secret keys are committed', () => {
  const found = [];
  for (const f of repoFiles()) {
    const text = readFileSync(new URL(f, root), 'utf8');
    for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g)) {
      if (jwtRole(m[0]) !== 'anon') found.push(`${f}: JWT with role ${jwtRole(m[0])}`);
    }
    if (/sb_secret_[A-Za-z0-9]/.test(text)) found.push(`${f}: sb_secret_ key`);
    if (/postgres(ql)?:\/\/[^:\s]+:(?!postgres@)[^@\s]+@/.test(text)) found.push(`${f}: database password`);
  }
  assert.deepEqual(found, []);
});

test('files: pages load scripts only from the pinned CDN versions, and no inline event handlers', () => {
  const allowed = new Set([
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm',
    'https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js',
  ]);
  const web = new URL('web/', root);
  for (const f of readdirSync(web).filter((n) => /\.(html|js)$/.test(n))) {
    const text = readFileSync(new URL(f, web), 'utf8');
    for (const m of text.matchAll(/(?:src=|from\s+)["'](https?:\/\/[^"']+)["']/g)) {
      assert.ok(allowed.has(m[1]), `${f} loads ${m[1]}`);
    }
    assert.doesNotMatch(text, /<[^>]+\son[a-z]+\s*=/i, `${f} has an inline event handler`);
  }
  // The rider link holds the token; the rider page must not send it to other sites as a referrer
  assert.match(readFileSync(new URL('rider.html', web), 'utf8'), /<meta name="referrer" content="no-referrer">/);
});

const ANON_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
// Fake keys built at run time, so this file holds no key-shaped text for secret scanners
const fakeJwt = (role) => ['{"alg":"HS256","typ":"JWT"}', JSON.stringify({ iss: 'test', role })]
  .map((p) => Buffer.from(p).toString('base64url')).concat('TESTONLYnotarealsignature').join('.');
const SERVICE_JWT = fakeJwt('service_role');
const PG_URL = ['postgresql://postgres', 'hunter2@db.abcd.supabase.co:5432/postgres'].join(':');

function writeConfig(url, key) {
  const out = join(mkdtempSync(join(tmpdir(), 'rally-config-')), 'config.js');
  const r = spawnSync(process.execPath, ['scripts/write-config.mjs'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, SUPABASE_URL: url, SUPABASE_ANON_KEY: key, CONFIG_OUT: out } });
  let written = null;
  try { written = readFileSync(out, 'utf8'); } catch { /* not written */ }
  return { code: r.status, output: r.stdout + r.stderr, written };
}

test('config script: refuses secret keys and never prints passwords', () => {
  // The service role key and secret keys bypass every rule; they must never reach the public site
  for (const key of [SERVICE_JWT, ['sb', 'secret', 'TESTONLYnotarealkey0000000000'].join('_')]) {
    const r = writeConfig('https://abcd.supabase.co', key);
    assert.equal(r.code, 1);
    assert.equal(r.written, null);
    assert.match(r.output, /secret|service/i);
    assert.ok(!r.output.includes(key), 'key not echoed');
  }
  // A pasted database connection string or a URL with a password: never echoed
  const pg = writeConfig(PG_URL, ANON_JWT);
  assert.equal(pg.code, 1);
  assert.ok(!pg.output.includes('hunter2'));
  const cred = writeConfig('https://user:hunter2@abcd.supabase.co/rest/v1/', ANON_JWT);
  assert.equal(cred.code, 0);
  assert.ok(!cred.output.includes('hunter2') && !cred.written.includes('hunter2'));
  assert.match(cred.written, /SUPABASE_URL = 'https:\/\/abcd\.supabase\.co'/);
  // Public keys are fine
  assert.equal(writeConfig('https://abcd.supabase.co', ANON_JWT).code, 0);
  assert.equal(writeConfig('https://abcd.supabase.co', 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH').code, 0);
});

// ---------------------------------------------------------------------------
// Part 3: hostile text in every page (names, notes, reasons, emails, error messages)
// ---------------------------------------------------------------------------
useBrowser();
const EVIL = `"'><img src=x onerror="window.__xss=1"><script>window.__xss=2</script>`;
async function assertInert(page, errors) {
  await page.waitForTimeout(300);   // give a broken image time to fire onerror
  assert.equal(await page.evaluate(() => window.__xss), undefined, 'hostile text ran as code');
  assert.equal(await page.locator('img[src="x"]').count(), 0, 'hostile text became an element');
  assert.deepEqual(errors, []);
}
const claimRow = (extra = {}) => ({
  id: 'c1', status: 'pending', bonus_code: 'ABCD', bonus_name: EVIL, points: 100, bonus_is_combo: false,
  rider_number: 42, rider_name: EVIL, submitted_at: new Date().toISOString(), submitted_by: EVIL,
  photo_path: `${TOKEN}/p.jpg`, note: EVIL, reason: EVIL, decided_by: EVIL, bonus_ref_photo: null, ...extra });
const signed = (c) => ({ json: c.json.paths.map((p) => ({ path: p, signedURL: `/object/sign/claims/${p}?token=t`, error: null })) });

test('pages: hostile text shows as text on the rider page', async () => {
  const evilSession = {
    event_name: EVIL, claims_open: true, max_attempts: 3, rider: { number: 42, name: EVIL },
    score: { total: 0, base_points: 0, worst_penalty: null, bonuses_counted: 0 },
    bonuses: [{ code: 'ABCD', name: EVIL, points: 100, description: EVIL, is_combo: false, attempts: 1, status: 'denied',
      counted: false, ref_photo: null, history: [{ status: 'denied', submitted_at: new Date().toISOString(), photo_path: null, reason: EVIL, by_staff: false }] }],
  };
  const { page, errors } = await newPage({ 'POST /rest/v1/rpc/rider_session': () => ({ json: evilSession }) });
  await page.goto(`${APP}rider.html?t=${TOKEN}`);
  await page.getByRole('button', { name: /ABCD/ }).click();
  await page.locator('#c-history-list li').waitFor();
  assert.ok((await page.textContent('#c-history-list')).includes(EVIL));
  await assertInert(page, errors);

  const bad = await newPage({ 'POST /rest/v1/rpc/rider_session': () => ({ status: 400, json: { code: 'P0001', message: EVIL } }) });
  await bad.page.goto(`${APP}rider.html?t=${TOKEN}`);
  await bad.page.getByText(EVIL).first().waitFor();
  await assertInert(bad.page, bad.errors);
});

test('pages: hostile text shows as text on the review page (cards, table, dialog)', async () => {
  const { page, errors } = await newPage({
    'POST /rest/v1/rpc/staff_role': () => ({ json: 'scorer' }),
    'GET /rest/v1/bonuses': () => ({ json: [{ code: 'ABCD', name: EVIL, points: 100 }] }),
    'HEAD /rest/v1/claims': () => ({ headers: { 'content-range': '0-0/1' } }),
    'GET /rest/v1/claims_detail': () => ({ json: [claimRow()] }),
    'POST /storage/v1/object/sign/claims': signed,
  }, { session: true });
  await page.goto(`${APP}scorer.html`);
  await page.locator('.claim').waitFor();
  await page.locator('.claim .open-claim').click();
  await page.locator('#claim-dlg').waitFor();
  assert.ok((await page.textContent('#claim-dlg')).includes(EVIL));
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await page.locator('#table-pending [data-act="approved"]').waitFor();
  await page.getByRole('button', { name: 'Add claim' }).click();   // bonus names in the select
  await assertInert(page, errors);
});

test('pages: hostile text shows as text on the activity, admin and leader board pages', async () => {
  const ago = new Date().toISOString();
  const act = await newPage({
    'POST /rest/v1/rpc/staff_role': () => ({ json: 'admin' }),
    'GET /rest/v1/claim_activity': () => ({ json: [{ id: 1, at: ago, action: EVIL, actor: EVIL, rider_number: 42,
      rider_name: EVIL, bonus_code: 'ABCD', bonus_name: EVIL, points: 1, reason: EVIL }] }),
    'GET /rest/v1/rider_activity': () => ({ json: [{ rider_number: 42, name: EVIL, last_seen_at: null, claims: 0,
      pending: 0, approved: 0, denied: 0, last_claim_at: null, score: 0 }] }),
    'POST /rest/v1/rpc/scorer_list': () => ({ json: [{ email: EVIL, is_admin: false, last_sign_in_at: null }] }),
  }, { session: true });
  await act.page.goto(`${APP}activity.html`);
  await act.page.locator('#feed table.data').waitFor();
  await act.page.getByRole('button', { name: 'Riders', exact: true }).click();
  await act.page.getByRole('button', { name: 'Scorers', exact: true }).click();
  await assertInert(act.page, act.errors);

  const adm = await newPage({
    'POST /rest/v1/rpc/staff_role': () => ({ json: 'admin' }),
    'GET /rest/v1/settings': () => ({ json: { id: 1, event_name: EVIL, max_attempts: 3, claims_open: true } }),
    'GET /rest/v1/riders': () => ({ json: [{ id: 1, rider_number: 42, name: EVIL, email: EVIL, token: TOKEN }] }),
    'GET /rest/v1/bonuses': () => ({ json: [{ code: 'ABCD', name: EVIL, points: 1, sort_order: 1, description: EVIL, ref_photo_path: null }] }),
    'GET /rest/v1/combo_members': () => ({ json: [{ combo_code: 'ABCD', member_code: 'WXYZ' }] }),
  }, { session: true });
  await adm.page.goto(`${APP}admin.html`);
  await adm.page.locator('#riders tbody a').waitFor();
  assert.equal(await adm.page.inputValue('#s-name'), EVIL);
  await adm.page.click('[data-edit-rider="1"]');            // values go into input fields
  assert.equal(await adm.page.inputValue('#f-name'), EVIL);
  await adm.page.getByRole('button', { name: 'Cancel' }).click();
  await adm.page.click('[data-edit-bonus="ABCD"]');
  assert.equal(await adm.page.inputValue('#f-description'), EVIL);
  await assertInert(adm.page, adm.errors);

  const lb = await newPage({ 'POST /rest/v1/rpc/leaderboard': () => ({ json: [{ finish: 1, rider_number: 42, name: EVIL, score: 1, bonuses_counted: 1 }] }) });
  await lb.page.goto(`${APP}leaderboard.html`);
  await lb.page.getByText(EVIL).waitFor();
  await assertInert(lb.page, lb.errors);
});
