// Runs the real supabase/schema.sql inside PGlite (in-process Postgres) and checks the rules.
// Run: npm test
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const SCORER = 'scorer@example.com';   // reviews claims only
const ADMIN = 'admin@example.com';     // also runs the admin page
let db, token42, token7;

// Run fn as a Supabase role, optionally as a logged-in user with this email
async function as(role, email, fn) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify(email ? { email, role } : { role })]);
    await tx.exec(`set local role ${role}`);
    return fn(tx);
  });
}
const rider = (fn) => as('anon', null, fn);
const scorer = (fn) => as('authenticated', SCORER, fn);
const admin = (fn) => as('authenticated', ADMIN, fn);
const one = async (tx, sql, params) => (await tx.query(sql, params)).rows[0];
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });
const uuid = () => crypto.randomUUID();

before(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(read('./supabase_stubs.sql'));
  await db.exec(read('../supabase/schema.sql'));
  await db.exec(read('../supabase/schema.sql')); // re-running must be safe
  await db.exec(`
    insert into scorers (email) values ('${SCORER}');
    insert into scorers (email, is_admin) values ('${ADMIN}', true);
    insert into riders (rider_number, name, email) values (42, 'Jane Smith', 'jane@example.com'), (7, 'Bob Jones', null);
    insert into bonuses (code, name, points) values
      ('ABCD', 'Old mill', 100), ('WXYZ', 'Covered bridge', 50),
      ('ARSN', 'Mill + bridge combo', 25), ('ABC1', 'Gas stop', 10), ('LAT1', 'Late under 15 min', -25);
    insert into combo_members values ('ARSN', 'ABCD'), ('ARSN', 'WXYZ');
  `);
  token42 = (await db.query(`select token from riders where rider_number = 42`)).rows[0].token;
  token7 = (await db.query(`select token from riders where rider_number = 7`)).rows[0].token;
});

test('bonus code format is enforced', async () => {
  await rejects(db.exec(`insert into bonuses (code, points) values ('ABCD1', 1)`), /check constraint/);
  await rejects(db.exec(`insert into bonuses (code, points) values ('AB12', 1)`), /check constraint/);
});

test('anon key alone cannot read tables', async () => {
  for (const t of ['riders', 'claims', 'rider_scores', 'bonuses', 'settings', 'scorers', 'claim_activity', 'rider_activity']) {
    await rejects(rider((tx) => tx.query(`select * from ${t}`)), /permission denied/);
  }
});

test('table grants: admins can do what the admin page does; non-scorers see nothing', async () => {
  // Same operations as admin.html: settings update, riders/bonuses upsert and edit, combos replaced
  await admin(async (tx) => {
    await tx.query(`update settings set max_attempts = max_attempts`);
    await tx.query(`insert into riders (rider_number, name) values (900, 'Grant Test')
                    on conflict (rider_number) do update set name = excluded.name`);
    await tx.query(`insert into bonuses (code, points) values ('GRNT', 5)
                    on conflict (code) do update set points = excluded.points`);
    await tx.query(`update bonuses set ref_photo_path = 'GRNT/x.jpg' where code = 'GRNT'`);
    await tx.query(`delete from riders where rider_number = 900`);
    await tx.query(`delete from combo_members where combo_code = 'GRNT'`);
    for (const v of ['rider_scores', 'claims_detail', 'claim_events', 'scorers']) await tx.query(`select * from ${v}`);
    throw new Error('rollback');
  }).catch((e) => { if (e.message !== 'rollback') throw e; });

  const stranger = (fn) => as('authenticated', 'random@example.com', fn);
  assert.equal((await stranger((tx) => tx.query('select * from riders'))).rows.length, 0);
  assert.equal((await stranger((tx) => tx.query('select * from rider_scores'))).rows.length, 0);
  await rejects(stranger((tx) => tx.query(`insert into riders (rider_number, name) values (901, 'x')`)), /row-level security/);
});

test('rider session lists bonuses but hides penalties', async () => {
  const s = (await rider((tx) => one(tx, 'select rider_session($1) as s', [token42]))).s;
  assert.equal(s.rider.number, 42);
  assert.deepEqual(s.bonuses.map((b) => b.code).sort(), ['ABC1', 'ABCD', 'ARSN', 'WXYZ']);
  assert.equal(s.bonuses.find((b) => b.code === 'ARSN').is_combo, true);
  await rejects(rider((tx) => tx.query('select rider_session($1)', [uuid()])), /rider link is not valid/);
});

test('rider submit rules', async () => {
  const submit = (args) => rider((tx) => one(tx,
    'select rider_submit($1,$2,$3,$4,$5,$6) as r',
    [args.token ?? token42, args.client ?? uuid(), args.code, args.photo ?? null, args.note ?? null, null]));

  await rejects(submit({ code: 'ABCD' }), /photo is required/);
  await rejects(submit({ code: 'ABCD', photo: `${token7}/x.jpg` }), /does not belong/);
  await rejects(submit({ code: 'LAT1', photo: `${token42}/x.jpg` }), /Unknown bonus/);
  await rejects(submit({ code: 'NOPE', photo: `${token42}/x.jpg` }), /Unknown bonus/);

  const client = uuid();
  const a = (await submit({ code: ' abcd ', photo: `${token42}/1.jpg`, client })).r;
  assert.equal(a.status, 'pending');
  const again = (await submit({ code: 'ABCD', photo: `${token42}/1.jpg`, client })).r;
  assert.equal(again.duplicate, true);
  assert.equal(again.claim_id, a.claim_id);
  assert.equal((await db.query(`select count(*)::int n from claims where bonus_code = 'ABCD'`)).rows[0].n, 1);

  // combo needs no photo
  assert.equal((await submit({ code: 'ARSN' })).r.status, 'pending');

  // attempt limit (3)
  await submit({ code: 'ABC1', photo: `${token42}/2.jpg` });
  await submit({ code: 'ABC1', photo: `${token42}/3.jpg` });
  await submit({ code: 'ABC1', photo: `${token42}/4.jpg` });
  await rejects(submit({ code: 'ABC1', photo: `${token42}/5.jpg` }), /used all 3 attempts/);
});

test('photo uploads only into a real rider folder', async () => {
  await rider((tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('claims', $1)`, [`${token42}/ok.jpg`]));
  await rejects(rider((tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('claims', $1)`, [`${uuid()}/x.jpg`])), /row-level security/);
  await rejects(rider((tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('claims', 'junk.jpg')`)), /row-level security/);
  assert.equal((await rider((tx) => tx.query('select * from storage.objects'))).rows.length, 0); // anon cannot list
  assert.equal((await scorer((tx) => tx.query('select * from storage.objects'))).rows.length, 1);
});

test('only scorers can decide; status rules and audit', async () => {
  const claim = (await db.query(`select id from claims where bonus_code = 'ABCD'`)).rows[0].id;

  await rejects(rider((tx) => tx.query(`select scorer_decide($1, 'approved')`, [claim])), /permission denied/);
  await rejects(as('authenticated', 'random@example.com', (tx) => tx.query(`select scorer_decide($1, 'approved')`, [claim])), /Not authorized/);
  assert.equal((await as('authenticated', 'random@example.com', (tx) => tx.query('select * from claims'))).rows.length, 0);

  const c = (await scorer((tx) => one(tx, `select * from scorer_decide($1, 'approved')`, [claim])));
  assert.equal(c.status, 'approved');
  assert.equal(c.decided_by, SCORER);

  await rejects(scorer((tx) => tx.query(`select scorer_decide($1, 'denied', 'blurry')`, [claim])), /Revert it to pending first/);
  await rejects(scorer((tx) => tx.query(`update claims set photo_path = 'x' where id = $1`, [claim])), /permission denied/);

  const reverted = await scorer((tx) => one(tx, `select * from scorer_decide($1, 'pending')`, [claim]));
  assert.equal(reverted.decided_by, null);
  await scorer((tx) => tx.query(`select scorer_decide($1, 'approved')`, [claim]));

  const events = (await db.query(`select action, actor from claim_events where claim_id = $1 order by id`, [claim])).rows;
  assert.deepEqual(events.map((e) => e.action), ['submitted', 'approved', 'reverted', 'approved']);
  assert.equal(events[0].actor, 'rider 42');

  // second approval of the same bonus for the same rider is blocked
  const other = (await scorer((tx) => one(tx, `select id from scorer_add_claim(42, 'ABCD')`))).id;
  await rejects(scorer((tx) => tx.query(`select scorer_decide($1, 'approved')`, [other])), /already has another approved/);

  // rider cannot resubmit an approved bonus
  await rejects(rider((tx) => tx.query('select rider_submit($1,$2,$3,$4,null,null)', [token42, uuid(), 'ABCD', `${token42}/9.jpg`])), /already approved/);
});

test('scoring: combos auto-count and penalties scale the score', async () => {
  const score = async () => (await scorer((tx) => one(tx, 'select score::float s from rider_scores where rider_number = 42'))).s;
  assert.equal(await score(), 100); // ABCD only

  const wxyz = (await scorer((tx) => one(tx, `select * from scorer_add_claim(42, 'WXYZ', 'approved', 'entered at checkpoint')`)));
  assert.equal(wxyz.status, 'approved');
  assert.equal(await score(), 175); // 100 + 50 + ARSN combo 25, without approving ARSN's own claim
  const before = (await rider((tx) => one(tx, 'select rider_session($1) as s', [token42]))).s;
  const arsnRow = before.bonuses.find((b) => b.code === 'ARSN');
  assert.equal(arsnRow.counted, true, 'combo counts once all parts are approved');
  assert.notEqual(arsnRow.status, 'approved', 'its own claim is still not approved');
  assert.equal(before.bonuses.find((b) => b.code === 'ABC1').counted, false);
  assert.equal(Number(before.score.total), 175);

  // approving the combo's own claim too must not double count
  const arsn = (await db.query(`select id from claims where bonus_code = 'ARSN'`)).rows[0].id;
  await scorer((tx) => tx.query(`select scorer_decide($1, 'approved')`, [arsn]));
  assert.equal(await score(), 175);

  await scorer((tx) => tx.query(`select scorer_add_claim(42, 'LAT1', 'approved')`));
  assert.equal(await score(), 131.25); // 175 * (1 - 0.25)

  const board = (await rider((tx) => tx.query('select * from leaderboard()'))).rows;
  assert.equal(board[0].rider_number, 42);
  assert.equal(Number(board[0].finish), 1);
  assert.equal(Number(board[1].score), 0);

  const s = (await rider((tx) => one(tx, 'select rider_session($1) as s', [token42]))).s;
  assert.equal(s.bonuses.find((b) => b.code === 'ABCD').status, 'approved');
  assert.equal(s.bonuses.find((b) => b.code === 'ABC1').status, 'pending');
  // Rider sees the same score as the leader board, penalty included
  assert.equal(Number(s.score.total), 131.25);
  assert.equal(Number(s.score.total), Number(board[0].score));
  assert.equal(s.score.worst_penalty, -25);
  assert.equal(s.score.bonuses_counted, 3);
  // Rider 7 has nothing yet
  const s7 = (await rider((tx) => one(tx, 'select rider_session($1) as s', [token7]))).s;
  assert.deepEqual([Number(s7.score.total), s7.score.worst_penalty, s7.score.bonuses_counted], [0, null, 0]);
});

test('activity: rider last seen, claim feed, rider summary, scorer sign-ins', async () => {
  const seen = async (n) => (await db.query('select last_seen_at from riders where rider_number = $1', [n])).rows[0].last_seen_at;
  const openPage = (token) => rider((tx) => tx.query('select rider_session($1)', [token]));

  // Opening the page records the visit, at most once a minute
  await db.query(`update riders set last_seen_at = now() - interval '2 minutes' where rider_number = 42`);
  const old = await seen(42);
  await openPage(token42);
  const fresh = await seen(42);
  assert.ok(fresh > old, 'stale last_seen_at is updated');
  await openPage(token42);
  assert.equal((await seen(42)).getTime(), fresh.getTime(), 'not rewritten within a minute');

  // Never-opened link shows as null
  await db.query('update riders set last_seen_at = null where rider_number = 7');
  const ra = (await scorer((tx) => tx.query('select * from rider_activity order by rider_number'))).rows;
  const r7 = ra.find((r) => r.rider_number === 7), r42 = ra.find((r) => r.rider_number === 42);
  assert.equal(r7.last_seen_at, null);
  assert.equal(Number(r7.claims), 0);
  assert.ok(Number(r42.claims) >= 4);
  assert.equal(Number(r42.approved), 4); // ABCD, WXYZ, ARSN, LAT1
  assert.ok(Number(r42.pending) >= 1);   // ABC1
  assert.equal(Number(r42.score), 131.25);
  assert.ok(r42.last_claim_at);

  // Feed: rider submissions and scorer decisions, newest first, with rider and bonus filled in
  const feed = (await scorer((tx) => tx.query('select * from claim_activity order by at desc, id desc'))).rows;
  assert.ok(feed.some((e) => e.action === 'submitted' && e.actor === 'rider 42' && e.bonus_code === 'ABCD'));
  assert.ok(feed.some((e) => e.action === 'approved' && e.actor === SCORER && e.rider_number === 42));
  assert.ok(feed.every((e) => e.rider_name && e.bonus_code));

  // Non-scorers see nothing; anon cannot read at all
  const stranger = (fn) => as('authenticated', 'random@example.com', fn);
  assert.equal((await stranger((tx) => tx.query('select * from claim_activity'))).rows.length, 0);
  assert.equal((await stranger((tx) => tx.query('select * from rider_activity'))).rows.length, 0);

  // Scorer list with last sign-in from Supabase Auth
  await db.query(`insert into auth.users (email, last_sign_in_at) values ($1, now())`, [SCORER.toUpperCase()]);
  const list = (await scorer((tx) => tx.query('select * from scorer_list()'))).rows;
  assert.deepEqual(list.map((r) => [r.email, r.is_admin]), [[ADMIN, true], [SCORER, false]]);
  assert.ok(list[1].last_sign_in_at, 'matched case-insensitively');
  await rejects(stranger((tx) => tx.query('select * from scorer_list()')), /Not authorized/);
  await rejects(rider((tx) => tx.query('select * from scorer_list()')), /permission denied/);
});

test('closing claims and scorer reset', async () => {
  await db.exec('update settings set claims_open = false');
  await rejects(rider((tx) => tx.query('select rider_submit($1,$2,$3,$4,null,null)', [token7, uuid(), 'WXYZ', `${token7}/1.jpg`])), /Claims are closed/);
  await db.exec('update settings set claims_open = true');

  await rejects(scorer((tx) => tx.query(`select scorer_delete_all_claims('DELETE ALL CLAIMS')`)), /Only rally admins/);
  await rejects(admin((tx) => tx.query(`select scorer_delete_all_claims('yes')`)), /Type DELETE ALL CLAIMS/);
  const n = (await admin((tx) => one(tx, `select scorer_delete_all_claims('DELETE ALL CLAIMS') n`))).n;
  assert.ok(n > 0);
  assert.equal((await db.query('select count(*)::int n from claim_events')).rows[0].n, 0);
});

test('rider sees own submission history; photo lookup is for the Edge Function only', async () => {
  // Staff add a claim with their own photo for rider 7, deny it with a reason; rider 7 tries again
  const staff = (await scorer((tx) => one(tx,
    `select * from scorer_add_claim(7, 'ABC1', 'pending', null, 'scorer/staff1.jpg')`)));
  await scorer((tx) => tx.query(`select scorer_decide($1, 'denied', 'too dark')`, [staff.id]));
  await rider((tx) => tx.query('select rider_submit($1,$2,$3,$4,null,null)', [token7, uuid(), 'ABC1', `${token7}/h1.jpg`]));
  await rider((tx) => tx.query('select rider_submit($1,$2,$3,$4,null,null)', [token42, uuid(), 'ABC1', `${token42}/other.jpg`]));

  const s7 = (await rider((tx) => one(tx, 'select rider_session($1) as s', [token7]))).s;
  const h = s7.bonuses.find((b) => b.code === 'ABC1').history;
  assert.deepEqual(h.map((c) => [c.status, c.photo_path, c.by_staff, c.reason]), [
    ['pending', `${token7}/h1.jpg`, false, null],                    // newest first
    ['denied', 'scorer/staff1.jpg', true, 'too dark'],
  ]);
  assert.deepEqual(s7.bonuses.find((b) => b.code === 'ABCD').history, []);

  // The Edge Function (service_role) gets only this rider's photo paths
  const service = (fn) => as('service_role', null, fn);
  const paths = (await service((tx) => one(tx, 'select rider_photo_paths($1) as p', [token7]))).p;
  assert.deepEqual(paths, ['scorer/staff1.jpg', `${token7}/h1.jpg`]);
  await rejects(service((tx) => tx.query('select rider_photo_paths($1)', [uuid()])), /rider link is not valid/);
  await rejects(rider((tx) => tx.query('select rider_photo_paths($1)', [token7])), /permission denied/);
  await rejects(as('authenticated', SCORER, (tx) => tx.query('select rider_photo_paths($1)', [token7])), /permission denied/);

  // Riders still cannot list or read storage, so folder names (tokens) never leak
  await rider((tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('claims', $1)`, [`${token7}/h1.jpg`]));
  assert.ok((await db.query('select count(*)::int n from storage.objects')).rows[0].n > 0);
  assert.equal((await rider((tx) => tx.query('select * from storage.objects'))).rows.length, 0);
});

test('admin can hide the score (and leader board) and the results from riders; the database does the hiding', async () => {
  // Rider 7 already has a denied staff claim (with a reason) and a pending claim for ABC1
  const c = await scorer((tx) => one(tx, `select * from scorer_add_claim(7, 'ABCD', 'approved')`));
  const show = async () => (await rider((tx) => one(tx, 'select rider_session($1) as s', [token7]))).s;
  let s = await show();
  assert.equal(s.shows_score, true);
  assert.equal(s.shows_status, true);
  assert.ok(s.score && s.score.total > 0);
  assert.equal(s.bonuses.find((b) => b.code === 'ABCD').status, 'approved');

  // A plain scorer cannot change the flags; an admin can
  assert.equal((await scorer((tx) => tx.query('update settings set rider_sees_score = false'))).affectedRows, 0);
  await admin((tx) => tx.query('update settings set rider_sees_score = false, rider_sees_status = false'));
  s = await show();
  assert.equal(s.shows_score, false);
  assert.equal(s.shows_status, false);
  assert.equal(s.score, null);
  const abcd = s.bonuses.find((b) => b.code === 'ABCD');
  const abc1 = s.bonuses.find((b) => b.code === 'ABC1');
  assert.deepEqual([abcd.status, abcd.counted, abcd.history[0].status], ['received', false, 'received']);
  assert.deepEqual(abc1.history.map((h) => [h.status, h.reason]), [['received', null], ['received', null]]);
  assert.equal(s.bonuses.find((b) => b.code === 'WXYZ').status, null, 'nothing sent: no status');
  const text = JSON.stringify(s);
  for (const word of ['approved', 'denied', 'pending', 'too dark']) assert.ok(!text.includes(word), `${word} hidden`);
  // Sending an approved bonus again is still refused, without saying it was approved
  await rejects(rider((tx) => tx.query('select rider_submit($1,$2,$3,$4,null,null)', [token7, uuid(), 'ABCD', `${token7}/again.jpg`])),
    /ABCD was already received/);
  // Scorers still see everything, including the leader board; the public board is hidden
  assert.equal((await scorer((tx) => one(tx, 'select status from claims where id = $1', [c.id]))).status, 'approved');
  assert.ok((await scorer((tx) => tx.query('select * from leaderboard()'))).rows.length > 0);
  await rejects(rider((tx) => tx.query('select * from leaderboard()')), /leader board is hidden/);
  await rejects(as('authenticated', 'random@example.com', (tx) => tx.query('select * from leaderboard()')), /leader board is hidden/);
  // Hiding only the results keeps the board public
  await admin((tx) => tx.query('update settings set rider_sees_score = true'));
  assert.ok((await rider((tx) => tx.query('select * from leaderboard()'))).rows.length > 0);

  await admin((tx) => tx.query('update settings set rider_sees_score = true, rider_sees_status = true'));
  await rejects(rider((tx) => tx.query('select rider_submit($1,$2,$3,$4,null,null)', [token7, uuid(), 'ABCD', `${token7}/again.jpg`])),
    /already approved for you/);
  await scorer((tx) => tx.query(`select scorer_decide($1, 'pending')`, [c.id]));
  await scorer((tx) => tx.query(`select scorer_decide($1, 'denied', 'undo')`, [c.id]));
});

test('scorers review; only admins change the event setup', async () => {
  assert.equal((await scorer((tx) => one(tx, 'select staff_role() r'))).r, 'scorer');
  assert.equal((await admin((tx) => one(tx, 'select staff_role() r'))).r, 'admin');
  assert.equal((await as('authenticated', 'random@example.com', (tx) => one(tx, 'select staff_role() r'))).r, null);
  assert.equal((await rider((tx) => one(tx, 'select staff_role() r'))).r, null);

  // A plain scorer can read the setup (the review page needs it) but not change it
  await scorer(async (tx) => {
    assert.ok((await tx.query('select * from riders')).rows.length > 0);
    assert.ok((await tx.query('select * from bonuses')).rows.length > 0);
    assert.ok((await tx.query('select * from combo_members')).rows.length > 0);
    assert.equal((await tx.query('select * from settings')).rows.length, 1);
  });
  await rejects(scorer((tx) => tx.query(`insert into riders (rider_number, name) values (902, 'x')`)), /row-level security/);
  assert.equal((await scorer((tx) => tx.query(`update settings set max_attempts = 9`))).affectedRows, 0);
  assert.equal((await scorer((tx) => tx.query(`update bonuses set points = 1`))).affectedRows, 0);
  assert.equal((await scorer((tx) => tx.query(`delete from riders`))).affectedRows, 0);
  for (const sql of [`select scorer_new_token(42)`, `select admin_delete_all('riders', 'DELETE ALL RIDERS')`,
    `select admin_set_combo('ARSN', array['ABCD'])`]) {
    await rejects(scorer((tx) => tx.query(sql)), /Only rally admins/);
  }
  // Scorers can still add and decide claims
  const c = await scorer((tx) => one(tx, `select * from scorer_add_claim(42, 'ABC1', 'pending')`));
  await scorer((tx) => tx.query(`select scorer_decide($1, 'denied', 'test')`, [c.id]));
});

test('admin: edit a combo, reference photos, delete everything', async () => {
  // Combos are set as a whole and checked
  await rejects(admin((tx) => tx.query(`select admin_set_combo('NOPE', array['ABCD','WXYZ'])`)), /Bonus NOPE not found/);
  await rejects(admin((tx) => tx.query(`select admin_set_combo('ARSN', array['ARSN','ABCD'])`)), /cannot include itself/);
  await rejects(admin((tx) => tx.query(`select admin_set_combo('ARSN', array['ABCD','ZZZZ'])`)), /Bonus not found: ZZZZ/);
  await rejects(admin((tx) => tx.query(`select admin_set_combo('ARSN', array['ABCD'])`)), /at least 2/);
  const n = (await admin((tx) => one(tx, `select admin_set_combo(' arsn ', array['abcd',' WXYZ ','ABC1','ABCD']) n`))).n;
  assert.equal(n, 3);
  const members = async () => (await db.query(`select member_code from combo_members where combo_code = 'ARSN' order by 1`)).rows.map((r) => r.member_code);
  assert.deepEqual(await members(), ['ABC1', 'ABCD', 'WXYZ']);
  await admin((tx) => tx.query(`select admin_set_combo('ARSN', array['ABCD','WXYZ'])`));
  assert.deepEqual(await members(), ['ABCD', 'WXYZ']);

  // Reference photo reaches the rider page and the scorer's claim view
  await admin((tx) => tx.query(`update bonuses set ref_photo_path = 'ABCD/ref.jpg' where code = 'ABCD'`));
  const s = (await rider((tx) => one(tx, 'select rider_session($1) as s', [token42]))).s;
  assert.equal(s.bonuses.find((b) => b.code === 'ABCD').ref_photo, 'ABCD/ref.jpg');
  assert.equal(s.bonuses.find((b) => b.code === 'WXYZ').ref_photo, null);
  await admin((tx) => tx.query(`select scorer_add_claim(42, 'ABCD', 'pending')`));
  const d = await scorer((tx) => one(tx, `select bonus_ref_photo from claims_detail where bonus_code = 'ABCD' limit 1`));
  assert.equal(d.bonus_ref_photo, 'ABCD/ref.jpg');

  // Only admins may upload reference photos
  await admin((tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('bonus-photos', 'ABCD/ref.jpg')`));
  await rejects(scorer((tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('bonus-photos', 'x.jpg')`)), /row-level security/);
  await rejects(rider((tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('bonus-photos', $1)`, [`${token42}/x.jpg`])), /row-level security/);
  assert.equal((await scorer((tx) => tx.query(`select * from storage.objects where bucket_id = 'bonus-photos'`))).rows.length, 0);
  assert.equal((await admin((tx) => tx.query(`select * from storage.objects where bucket_id = 'bonus-photos'`))).rows.length, 1);

  // Delete all needs the exact phrase for that list
  await rejects(admin((tx) => tx.query(`select admin_delete_all('claims', 'DELETE ALL CLAIMS')`)), /Unknown list/);
  await rejects(admin((tx) => tx.query(`select admin_delete_all('riders', 'DELETE ALL BONUSES')`)), /Type DELETE ALL RIDERS/);
  const count = async (t) => (await db.query(`select count(*)::int n from ${t}`)).rows[0].n;

  assert.equal((await admin((tx) => one(tx, `select admin_delete_all('combos', 'DELETE ALL COMBOS') n`))).n, 2);
  assert.equal(await count('combo_members'), 0);
  assert.ok(await db.query(`select 1 from bonuses where code = 'ARSN'`).then((r) => r.rows.length === 1), 'combo bonus stays');

  const riders = await count('riders');
  assert.equal((await admin((tx) => one(tx, `select admin_delete_all('riders', 'DELETE ALL RIDERS') n`))).n, riders);
  assert.equal(await count('riders'), 0);
  assert.equal(await count('claims'), 0);

  await db.exec(`insert into riders (rider_number, name) values (5, 'Back Again')`);
  await db.exec(`insert into claims (rider_id, bonus_code, status) select id, 'ABCD', 'pending' from riders`);
  await db.exec(`insert into combo_members values ('ARSN', 'ABCD'), ('ARSN', 'WXYZ')`);
  const bonuses = await count('bonuses');
  assert.equal((await admin((tx) => one(tx, `select admin_delete_all('bonuses', 'DELETE ALL BONUSES') n`))).n, bonuses);
  assert.equal(await count('bonuses'), 0);
  assert.equal(await count('claims'), 0);
  assert.equal(await count('combo_members'), 0);
  assert.equal(await count('riders'), 1, 'riders are kept');
});

test('existing scorers become admins when the admin column is first added', async () => {
  await db.transaction(async (tx) => {
    await tx.exec(`alter table scorers drop column is_admin; insert into scorers (email) values ('old@example.com');`);
    await tx.exec(read('../supabase/schema.sql'));
    const r = (await tx.query(`select bool_and(is_admin) all_admin from scorers`)).rows[0];
    assert.equal(r.all_admin, true);
    await tx.exec(`insert into scorers (email) values ('new@example.com')`);
    await tx.exec(read('../supabase/schema.sql'));   // re-run does not promote new scorers
    assert.equal((await tx.query(`select is_admin from scorers where email = 'new@example.com'`)).rows[0].is_admin, false);
    await tx.rollback();
  });
});

test('reset.sql removes everything', async () => {
  await db.exec(read('../supabase/reset.sql'));
  const left = (await db.query(`select count(*)::int n from pg_tables where schemaname = 'public'`)).rows[0].n;
  assert.equal(left, 0);
  await db.exec(read('../supabase/schema.sql')); // and schema installs again cleanly
});
