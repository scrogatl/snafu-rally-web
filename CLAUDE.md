# CLAUDE.md - snafu-rally-web

Replacement for the Gmail + Apps Script + Google Sheets scoring in `scrogatl/snafu-rally-scoring`.
Goal: make bonus scoring exact and hard to get wrong, instead of relying on email subject lines,
labels and sheet formulas.

Full build spec (schema, functions, pages, tests, exact messages): `SPEC.md`. Keep it in step with
the code when behavior changes. Setup steps for people: `README.md`.

## Event profile (drives design choices)
- About 40 riders, 10-hour rally, aimed at beginners. Keep the rider side dead simple.
- Riders often lose signal; submitting later when back in coverage is acceptable.
- LD Rally App was considered and rejected: too advanced for beginners.

## Architecture
- Static pages in `web/` (plain HTML + ES modules, no build step). supabase-js 2.45.4 from jsdelivr,
  PapaParse 5.4.1 from cdnjs.
- Supabase: Postgres for rules, scoring and audit; Storage bucket `claims` (private) for photos;
  Auth email links for scorers only.
- Riders never log in. Each rider has a secret `token` in their link (`rider.html?t=...`). All rider
  actions go through SECURITY DEFINER functions that take the token (`rider_session`, `rider_submit`).
- Scorers = emails in the `scorers` table. RLS gives them full read; claim changes only through
  `scorer_decide` / `scorer_add_claim` so the status rules and audit always apply.
- Scoring mirrors the old sheet: sum of approved positive points x (1 + worst approved penalty / 100).
  Combos auto-count when all members are approved (one level only). Penalties are negative-point bonuses
  that only scorers add.

## Decisions
- Bonus codes: 4 letters, or 3 letters + 1 digit, upper case (DB check constraint).
- Max attempts per bonus: setting, default 3.
- Photos are shrunk on the phone (~1600 px JPEG) before upload; metadata is not kept for now.
- TABLED: location check against bonus coordinates. Plan when resumed: capture device GPS at photo time
  in the app (EXIF GPS is unreliable from mobile browsers), compute distance in the DB, flag for the
  scorer rather than auto-deny.
- Not built yet: offline auto-send queue, QR codes for rider packets, bonus time windows, nested combos.

## Working style
- Plain English in code and messages; ASCII only in code (no special characters).
- Keep config separate from code (`web/config.js`).
- Rules belong in the database, not only in the UI.
- Small, reviewed, iterative changes; run tests before calling something done.

## Commands
```
npm install
npm run test:setup   # one time, Chromium for browser tests
npm test             # all tests
npm run test:db      # schema tests only (PGlite, no Docker, seconds)
npm run serve        # pages at http://localhost:8080
```
Local Supabase: `supabase/config.toml` exists (redirects to localhost:8080). No migrations yet; load the
schema with `docker exec -i supabase_db_snafu-rally-web psql -U postgres -q < supabase/schema.sql`
and insert scorer emails by hand. Mail viewer (Mailpit) at :54324, Studio at :54323.
If migrations become the source of truth, point `tests/schema.test.mjs` at them.

## Config and hosting
- Committed `web/config.js` = local Supabase values (public demo anon key). Do not commit hosted values.
- Netlify deploys from GitHub: `netlify.toml` publishes `web/` and runs `scripts/write-config.mjs`,
  which overwrites `web/config.js` from env vars `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
- `web/serve.json` sets `cleanUrls: false`; without it `npm run serve` redirects `rider.html?t=...`
  to `/rider` and drops the token.

## Tests
- `tests/schema.test.mjs`: runs the real schema in PGlite with stub auth/storage
  (`tests/supabase_stubs.sql`) and switches roles (anon, non-scorer, scorer).
  Gotcha: `select (fn()).*` calls fn once per column; use `select * from fn()`.
- `tests/web.test.mjs`: Playwright loads the real pages against a fake Supabase API. CDN scripts are
  served from node_modules (supabase-js bundled with esbuild into `tmp/`).
