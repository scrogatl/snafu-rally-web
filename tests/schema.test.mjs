// Runs the real supabase/schema.sql inside PGlite (in-process Postgres) and checks the rules.
// Run: npm test
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const SCORER = 'scorer@example.com';
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
const one = async (tx, sql, params) => (await tx.query(sql, params)).rows[0];
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });
const uuid = () => crypto.randomUUID();

before(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(read('./supabase_stubs.sql'));
  await db.exec(read('../supabase/schema.sql'));
  await db.exec(read('../supabase/schema.sql')); // re-running must be safe
  await db.exec(`
    insert into scorers values ('${SCORER}');
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
  for (const t of ['riders', 'claims', 'rider_scores', 'bonuses', 'settings', 'scorers']) {
    await rejects(rider((tx) => tx.query(`select * from ${t}`)), /permission denied/);
  }
});

test('table grants: scorers can do what the admin page does; non-scorers see nothing', async () => {
  // Same operations as admin.html: settings update, riders/bonuses upsert, combos replaced
  await scorer(async (tx) => {
    await tx.query(`update settings set max_attempts = max_attempts`);
    await tx.query(`insert into riders (rider_number, name) values (900, 'Grant Test')
                    on conflict (rider_number) do update set name = excluded.name`);
    await tx.query(`insert into bonuses (code, points) values ('GRNT', 5)
                    on conflict (code) do update set points = excluded.points`);
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

test('closing claims and scorer reset', async () => {
  await db.exec('update settings set claims_open = false');
  await rejects(rider((tx) => tx.query('select rider_submit($1,$2,$3,$4,null,null)', [token7, uuid(), 'WXYZ', `${token7}/1.jpg`])), /Claims are closed/);
  await db.exec('update settings set claims_open = true');

  await rejects(scorer((tx) => tx.query(`select scorer_delete_all_claims('yes')`)), /Type DELETE ALL CLAIMS/);
  const n = (await scorer((tx) => one(tx, `select scorer_delete_all_claims('DELETE ALL CLAIMS') n`))).n;
  assert.ok(n > 0);
  assert.equal((await db.query('select count(*)::int n from claim_events')).rows[0].n, 0);
});

test('reset.sql removes everything', async () => {
  await db.exec(read('../supabase/reset.sql'));
  const left = (await db.query(`select count(*)::int n from pg_tables where schemaname = 'public'`)).rows[0].n;
  assert.equal(left, 0);
  await db.exec(read('../supabase/schema.sql')); // and schema installs again cleanly
});
