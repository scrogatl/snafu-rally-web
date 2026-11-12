# SPEC - snafu-rally-web

Build specification. An AI coding agent given only this file (plus `LICENSE`) should be able to
rebuild the app with the same behavior, files and tool set. Where this spec gives exact names
(tables, functions, columns, messages, file paths), use them exactly.

---

## 1. Purpose and context

Replace a Gmail + Apps Script + Google Sheets bonus-scoring process for a motorcycle rally
(the "SNAFU rally"). The old process relied on riders typing bonus codes into email subject lines
and on spreadsheet formulas. The new system must make scoring exact and hard to get wrong.

Event profile (drives every design choice):
- About 40 riders, 10-hour rally, aimed at beginners. The rider side must be dead simple.
- Riders often lose signal. Submitting later when back in coverage is acceptable.
- One event per Supabase project.

Principles:
- **Rules live in the database**, not only in the UI. The UI only gives friendlier messages.
- Riders never log in. A secret token in their personal link identifies them.
- Scorers log in with an emailed magic link; only emails in a `scorers` table have access.
- Plain HTML + ES modules, **no build step** for the pages.
- Plain English in code, comments and messages. ASCII only in code.
- Config separate from code (`web/config.js`).

---

## 2. Tool set (use exactly these)

| Area | Tool | Version / note |
|---|---|---|
| Backend | Supabase (Postgres, Auth email OTP / magic link, Storage) | Free plan works |
| Client DB library | `@supabase/supabase-js` | **2.45.4**, loaded in the browser from `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm` |
| CSV parsing | PapaParse | **5.4.1**, from `https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js` (admin page only, classic script, `window.Papa`) |
| Hosting | Netlify, deployed from GitHub | `netlify.toml` |
| Local static server | `serve` via `npx --yes serve web -l 8080` | |
| Local Supabase | Supabase CLI (`npx supabase start`), Docker | project id `snafu-rally-web` |
| Tests runner | Node built-in `node:test` + `node:assert/strict` | Node 20+ |
| DB tests | `@electric-sql/pglite` ^0.5.16 | in-process Postgres |
| Browser tests | `playwright` ^1.63.0 (Chromium) | |
| Test bundling | `esbuild` ^0.28.2 | bundles supabase-js for offline tests |
| Dev deps also | `@supabase/supabase-js` 2.45.4, `papaparse` ^5.4.1 | served from node_modules in tests |

`package.json`:
```json
{
  "name": "snafu-rally-web",
  "version": "1.0.0",
  "description": "SNAFU rally bonus claims and scoring: static web app + Supabase",
  "scripts": {
    "test:setup": "playwright install chromium",
    "test": "node --test tests/schema.test.mjs tests/web.test.mjs",
    "test:db": "node --test tests/schema.test.mjs",
    "serve": "npx --yes serve web -l 8080"
  },
  "license": "GPL-3.0-or-later",
  "private": true,
  "type": "module",
  "devDependencies": {
    "@electric-sql/pglite": "^0.5.16",
    "@supabase/supabase-js": "2.45.4",
    "esbuild": "^0.28.2",
    "papaparse": "^5.4.1",
    "playwright": "^1.63.0"
  }
}
```

License: GPL-3.0-or-later (same as the original `snafu-rally-scoring` repo).

---

## 3. File layout

```
.gitignore                 node_modules/, tmp/, .DS_Store, supabase/snippets/
CLAUDE.md                  short agent notes (context, decisions, commands)
LICENSE                    GPL v3
README.md                  setup guide
SPEC.md                    this file
netlify.toml               publish web/, build = node scripts/write-config.mjs
package.json
samples/rider-master.csv   Rider Number,Name,Email
samples/bonus-master.csv   Bonus ID,POINTS,Name,Description
samples/combo-master.csv   Combo ID,Member Bonus ID
scripts/write-config.mjs   writes web/config.js from env vars (hosted build)
supabase/config.toml       Supabase CLI config (project_id snafu-rally-web)
supabase/.gitignore        .branches, .temp, .env.keys, .env.local, .env.*.local
supabase/schema.sql        the whole database (idempotent, paste into SQL Editor)
supabase/reset.sql         drops everything schema.sql creates
tests/supabase_stubs.sql   minimal auth/storage/roles stand-ins for PGlite
tests/schema.test.mjs      DB tests
tests/web.test.mjs         browser tests
web/config.js              SUPABASE_URL, SUPABASE_ANON_KEY (committed = local values)
web/serve.json             { "cleanUrls": false }
web/lib.js                 shared helpers
web/styles.css
web/index.html             landing
web/rider.html
web/scorer.html
web/admin.html
web/leaderboard.html
```

---

## 4. Database (`supabase/schema.sql`)

Single idempotent file: `create ... if not exists`, `create or replace`, `drop policy if exists`
before `create policy`, enum created in a `do $$ ... exception when duplicate_object` block.
Starts with `create extension if not exists pgcrypto;`. Header comment says: paste into
Supabase SQL Editor and Run; safe to re-run; run reset.sql first to start over.

### 4.1 Tables

**settings** (single row)
- `id int primary key default 1 check (id = 1)`
- `event_name text not null default 'SNAFU Rally'`
- `max_attempts int not null default 3 check (max_attempts between 1 and 10)`
- `claims_open boolean not null default true`
- Seed: `insert into settings (id) values (1) on conflict do nothing;`

**scorers**
- `email text primary key check (email = lower(email))`

**riders**
- `id bigint generated always as identity primary key`
- `rider_number int not null unique check (rider_number > 0)`
- `name text not null check (length(trim(name)) > 0)`
- `email text`
- `token uuid not null unique default gen_random_uuid()`
- `created_at timestamptz not null default now()`

**bonuses**
- `code text primary key check (code ~ '^([A-Z]{4}|[A-Z]{3}[0-9])$')` (4 letters, or 3 letters + 1 digit)
- `name text`, `points int not null` (negative = percent penalty), `description text`,
  `sort_order int`, `created_at timestamptz not null default now()`

**combo_members**
- `combo_code text not null references bonuses(code) on update cascade on delete cascade`
- `member_code text not null references bonuses(code) on update cascade on delete cascade`
- `primary key (combo_code, member_code)`, `check (combo_code <> member_code)`

**claim_status** enum: `'pending', 'approved', 'denied'`

**claims** (one row per submission attempt)
- `id uuid primary key default gen_random_uuid()`
- `client_id uuid unique` (set by the phone; makes retries idempotent)
- `rider_id bigint not null references riders(id) on delete cascade`
- `bonus_code text not null references bonuses(code) on update cascade` (no delete cascade:
  deleting a bonus that has claims is blocked on purpose)
- `photo_path text` (object path in bucket `claims`)
- `note text check (length(note) <= 500)`
- `taken_at timestamptz` (photo file time reported by the phone)
- `submitted_at timestamptz not null default now()`
- `submitted_by text not null default 'rider'` (`'rider <number>'` or scorer email)
- `status claim_status not null default 'pending'`
- `decided_by text`, `decided_at timestamptz`
- `reason text check (length(reason) <= 500)`
- Indexes: unique partial `claims_one_approved on claims (rider_id, bonus_code) where status = 'approved'`;
  `claims_status_idx (status, submitted_at)`; `claims_rider_idx (rider_id, bonus_code)`.

**claim_events** (audit log, written only by trigger)
- `id bigint generated always as identity primary key`
- `claim_id uuid not null references claims(id) on delete cascade`
- `action text not null` (`submitted` / `approved` / `denied` / `reverted`)
- `from_status claim_status`, `to_status claim_status not null`
- `actor text not null`, `reason text`, `at timestamptz not null default now()`
- Index `claim_events_claim_idx (claim_id, at)`

### 4.2 Helper functions

| Function | Returns | Notes |
|---|---|---|
| `current_email()` | text | `lower(nullif(coalesce(auth.jwt() ->> 'email', ''), ''))`, sql stable |
| `is_scorer()` | boolean | security definer, `search_path = public`; email in `scorers` |
| `rider_token_valid(p_token text)` | boolean | security definer; text matches `^[0-9a-fA-F-]{36}$` and a rider has that token. Used by the storage policy. |
| `rider_from_token(p_token uuid)` | riders | security definer; raises `'This rider link is not valid. Ask the rally staff for a new one.'` (errcode P0001) |
| `is_combo(p_code text)` | boolean | exists in `combo_members` as `combo_code` |
| `require_scorer()` | void | raises `'Not authorized. Your email is not on the scorer list.'` errcode `42501` |

All user-facing errors use `errcode = 'P0001'` unless noted, so the message reaches the page.

### 4.3 Triggers on `claims`

`claims_before_write` (BEFORE INSERT OR UPDATE, plpgsql, not security definer):
- Always `new.bonus_code := upper(trim(new.bonus_code))`.
- INSERT: if pending, clear `decided_by/decided_at`; else set
  `decided_by = coalesce(current_email(), new.submitted_by)`, `decided_at = now()`.
- UPDATE with status change: allowed only `pending -> approved|denied` or
  `approved|denied -> pending` (revert). Otherwise raise
  `'Cannot change a claim from % to %. Revert it to pending first.'`.
  To pending: clear decided fields. Else `decided_by = coalesce(current_email(), 'system')`, `decided_at = now()`.
- UPDATE: if `rider_id`, `bonus_code`, `photo_path` (is distinct from) or `submitted_at` changed, raise
  `'Claim evidence cannot be edited. Deny it and add a new claim instead.'`.

`claims_after_write` (AFTER INSERT OR UPDATE, security definer):
- INSERT: event `('submitted', null, new.status, new.submitted_by, new.reason)`.
- UPDATE with status change: action `'reverted'` if new status is pending, else the status text;
  actor `coalesce(current_email(), 'system')`; reason `new.reason`.

### 4.4 Scoring views (all `with (security_invoker = true)`)

- `approved_direct`: distinct `(rider_id, bonus_code)` from claims where approved.
- `approved_effective(rider_id, bonus_code, via_combo)`: approved_direct with `via_combo = false`,
  UNION each rider x each combo where every member is in approved_direct and the combo itself is
  not (so a combo never counts twice), `via_combo = true`. One level only (no nested combos).
- `rider_scores`: per rider (left joins, so riders with nothing still appear):
  `rider_id, rider_number, name, base_points` (sum of positive points, default 0),
  `worst_penalty` (min of negative points, null if none), `bonuses_counted` (count with points >= 0),
  `score = round(base_points * (1 + coalesce(worst_penalty, 0) / 100.0), 2)`.
- `claims_detail`: `claims.*` + `rider_number`, `rider_name`, `bonus_name`, `points`,
  `bonus_is_combo` (via `is_combo`).

Scoring rule (matches the old sheet): sum of approved positive bonuses, then multiplied by
`(1 + worst approved penalty / 100)`. Example: 160 pts with LAT1 (-25) = 120.

### 4.5 Rider functions (anon key + token, security definer)

**`rider_session(p_token uuid) returns json`** (stable):
```
{ event_name, claims_open, max_attempts,
  rider: { number, name },
  score: { total, base_points, worst_penalty, bonuses_counted },   // from rider_scores, 0 defaults
  bonuses: [ { code, name, points, description, is_combo,
               counted,      // in approved_effective for this rider
               attempts,     // count of this rider's claims for the bonus
               status } ] }  // 'approved' if any approved, else 'pending' if any pending,
                             // else 'denied' if any claims, else null
```
Bonuses: only `points >= 0` (penalties hidden from riders), ordered `sort_order nulls last, code`.

**`rider_submit(p_token uuid, p_client_id uuid, p_bonus_code text, p_photo_path text default null,
p_note text default null, p_taken_at timestamptz default null) returns json`** (volatile). In order:
1. Resolve rider from token.
2. If `p_client_id` already exists: if it belongs to another rider raise `'Duplicate submission id.'`;
   otherwise return `{claim_id, status, duplicate: true}` (retry-safe, checked before other rules).
3. If not `claims_open`: `'Claims are closed.'`
4. Code (upper/trim) unknown or points < 0: `'Unknown bonus code %.'`
5. No photo and not a combo: `'A photo is required for bonus %.'`
6. Photo path not starting with `<token>/`: `'Photo does not belong to this rider.'`
7. Already approved: `'Bonus % is already approved for you.'`
8. Attempts >= max: `'You have used all % attempts for bonus %. See rally staff.'`
9. Insert with `note = nullif(trim(p_note), '')`, `submitted_by = 'rider ' || rider_number`.
   Return `{claim_id, status: 'pending', duplicate: false}`.

### 4.6 Public function

**`leaderboard() returns table (finish bigint, rider_number int, name text, score numeric,
bonuses_counted bigint)`**: `rank() over (order by score desc)`, ordered by finish then rider_number.
Security definer, callable by anon.

### 4.7 Scorer functions (all call `require_scorer()` first, security definer)

- `scorer_decide(p_claim_id uuid, p_status claim_status, p_reason text default null) returns claims`:
  update status and `reason = nullif(trim(p_reason), '')`. Not found: `'Claim not found.'`.
  On unique_violation: `'This rider already has another approved claim for this bonus.'`
- `scorer_add_claim(p_rider_number int, p_bonus_code text, p_status claim_status default 'pending',
  p_note text default null, p_photo_path text default null, p_reason text default null) returns claims`:
  rider must exist (`'Rider % not found.'`), bonus must exist incl. penalties (`'Bonus % not found.'`),
  `submitted_by = current_email()`. No photo, attempt or open/closed checks (staff override).
  On unique_violation: `'Rider % already has bonus % approved.'`
- `scorer_new_token(p_rider_number int) returns uuid`: sets a new random token (old link dies).
- `scorer_delete_all_claims(p_confirm text) returns int`: requires exactly `'DELETE ALL CLAIMS'`
  (else `'Type DELETE ALL CLAIMS to confirm.'`); deletes all claims (events cascade); returns count.

### 4.8 Row level security and grants

- Enable RLS on all seven tables.
- Policies (to `authenticated`): `scorer_all` FOR ALL using/with check `is_scorer()` on settings,
  riders, bonuses, combo_members. `scorer_read` FOR SELECT `is_scorer()` on scorers, claims, claim_events.
  No write policies on claims: claims change only through functions.
- Grants (explicit so it works whether or not the project auto-exposes tables):
  - `grant usage on schema public to anon, authenticated, service_role`
  - `revoke all on all tables / sequences in schema public from anon, authenticated`
  - authenticated: select/insert/update/delete on settings, riders, bonuses, combo_members;
    select on scorers, claims, claim_events and the four views; usage/select on `riders_id_seq`.
  - service_role: all on tables and sequences.
  - anon: **no table access at all**.
- Functions: `revoke execute on all functions in schema public from public, anon, authenticated`, then:
  - anon + authenticated: `rider_session`, `rider_submit`, `leaderboard`, `is_scorer`,
    `current_email`, `rider_token_valid`, `is_combo`
  - authenticated only: `scorer_decide`, `scorer_add_claim`, `scorer_new_token`,
    `scorer_delete_all_claims`, `require_scorer`

### 4.9 Storage

- Bucket: `insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('claims', 'claims', false, 10485760, array['image/jpeg','image/png','image/webp','image/heic','image/heif'])
  on conflict (id) do nothing;`
- Policies on `storage.objects`:
  - `rider_upload` FOR INSERT to anon, authenticated: `bucket_id = 'claims' and
    public.rider_token_valid((storage.foldername(name))[1])`
  - `scorer_upload` FOR INSERT to authenticated: bucket `claims` and `public.is_scorer()`
  - `scorer_read_photos` FOR SELECT to authenticated: bucket `claims` and `public.is_scorer()`
- Paths: riders `<token>/<client_id>.<ext>`; scorers `scorer/<uuid>.<ext>`.

### 4.10 `supabase/reset.sql`

Drops the three storage policies, the views (`claims_detail, rider_scores, approved_effective,
approved_direct`), the tables, every function with its full signature, and the `claim_events`
type, all with `if exists ... cascade`. Comment notes photos in the bucket are not deleted.

---

## 5. Web pages (`web/`)

Shared conventions:
- Every page: `<meta name="viewport" content="width=device-width, initial-scale=1">`,
  `styles.css`, one `<script type="module">` importing from `./lib.js`, calls `setupBanner()`.
- Escape all data inserted as HTML with `esc()`.
- Mobile-first; touch targets at least 46px.

### 5.1 `config.js`
```js
export const SUPABASE_URL = 'http://127.0.0.1:54321';
export const SUPABASE_ANON_KEY = '<Supabase local demo anon key>';
```
with a comment: committed values are local Supabase; anon key is public by design; the Netlify
build overwrites this file. Use the standard Supabase CLI demo anon JWT (role `anon`,
iss `supabase-demo`).

### 5.2 `lib.js` exports
- `configured`: false if URL contains `YOUR-PROJECT-REF` or key starts with `YOUR-`.
- `sb = createClient(URL, KEY, { auth: { persistSession: true, detectSessionInUrl: true } })`
- `BUCKET = 'claims'`, `$(sel, root)`, `esc(v)` (escapes `& < > " '`)
- `fmtTime(v)`: locale string, month short, day, hour, 2-digit minute; '' for empty.
- `errorText(err)`: network errors (`Failed to fetch|NetworkError|Load failed|network`) become
  `'No signal or the server could not be reached. Your entry is kept - try again when you have coverage.'`;
  otherwise the message.
- `showMessage(el, text, kind='info')`: sets class `msg <kind>`, text, hides when empty.
- `setupBanner()`: if not configured, prepend error banner
  `'Setup needed: open web/config.js and fill in SUPABASE_URL and SUPABASE_ANON_KEY.'`
- `shrinkImage(file, maxEdge=1600, quality=0.8)`: `createImageBitmap(file, {imageOrientation:'from-image'})`,
  scale longest edge to <= 1600, canvas -> JPEG blob; returns `{blob, ext:'jpg', type:'image/jpeg', shrunk:true}`.
  On any failure (e.g. HEIC on Android) return the original file `{blob:file, ext, type, shrunk:false}`.
  Canvas re-encoding drops photo metadata (intended for now).
- `newId()`: `crypto.randomUUID` with a `getRandomValues` fallback (plain-http testing).
- `currentScorer()`: `{session, isScorer}` via `sb.auth.getSession()` and `rpc('is_scorer')`.
- `renderLogin(container, onDone)`: "Scorer sign in" card, email field, "Email me a link" button;
  `signInWithOtp({ email (lower), options: { emailRedirectTo: current URL without hash } })`;
  success message `Check <email> for the sign-in link. Open it on this device.`; calls `onDone` on `SIGNED_IN`.
- `navBar(active)`: links Review (scorer.html), Admin (admin.html), Leader board; "Sign out" link-button
  `#sign-out` aligned right. `wireSignOut()` signs out and reloads.

### 5.3 `index.html`
Title "Rally Scoring". Card: "Riders: use the personal link the rally staff sent you." and links to
leader board, scorer review, admin.

### 5.4 `rider.html` (most important; beginners on phones)
- Token from `?t=`; saved to `localStorage.rally_token`; if absent, read from localStorage
  (so a home-screen icon works). Wrap storage in try/catch. No token:
  `'Open this page from your personal rider link.'`
- Header: event name (also `document.title`) and `Rider <n> - <name>`.
- **Score card** at top: big total + `pts`; line joined with ` - `:
  `N bonus(es) approved`, `N waiting for review` (pending and not counted), `includes a X% penalty`.
  Hidden if `session.score` is missing.
- If claims closed: warn message `'Claims are closed.'`
- **List view**: tabs `To get`, `Claimed`, `All`, each with a count. "Claimed" = counted, approved,
  pending, or denied with no attempts left. A denied bonus with attempts left is "To get".
  On `All`, checkbox "Group claimed bonuses together" shows headings `To get (n)` / `Claimed (n)`.
  Filter and group choice are remembered in `localStorage.rally_list_prefs` (default
  `{filter:'all', group:true}`). Search box filters by code or name. Empty states:
  `No bonuses match.` / `Nothing left to get - every bonus is claimed.` / `No bonuses claimed yet.`
- Each bonus row: monospace code, name, `<points> pts` (+ ` - combo`), and a badge:
  approved `Approved`; counted `Counted - all parts approved`; pending `Waiting for review`;
  denied `Denied - you can try again` or `Denied - no attempts left`.
- **Claim view** (tap a bonus): back link "<- All bonuses", code + name, `<pts> pts - X of N attempts used`,
  description. Photo input `accept="image/*"` with label "(required)" or "(not needed for a combo)",
  preview image, optional note (max 500), big "Submit bonus" button.
  Blocked (form hidden, warn shown): claims closed; already approved; combo already counted;
  out of attempts (`'You have used all attempts for this bonus. See rally staff.'`).
- **Submit flow (retry-safe)**: choosing a photo creates a `draft = {clientId: newId(), file, uploadedPath: null}`.
  On submit: require photo unless combo (`'Add a photo first.'`); disable button;
  (1) if not yet uploaded: "Preparing photo..." -> shrink -> "Uploading photo..." -> upload to
  `<token>/<clientId>.<ext>` with `upsert:false`, treating "already exists/Duplicate" as success, then remember
  `uploadedPath`; (2) "Submitting..." -> `rpc('rider_submit', {...})` with `p_taken_at` from
  `file.lastModified`. On error keep the draft and show `errorText` (so tapping Submit again does not
  re-upload and reuses the same client id). On success: reload session, return to list, show
  `Received: <CODE>. It will show as approved once a scorer reviews it.`
- `online` event: `'Signal is back - you can submit now.'`
- On `visibilitychange` to visible, reload session only when the list view is showing.

### 5.5 `scorer.html`
- Not signed in -> `renderLogin`. Signed in but not scorer -> nav + `<email> is not on the scorer list. Ask the organizer to add it.`
- Heading "Review claims"; tabs `Pending (count)`, `Decided`, `Add claim`; filter box
  (digits = rider number exact, else bonus code prefix via `ilike`), debounced 300 ms; Refresh button.
- Pending: `claims_detail` where pending, oldest first. Decided: not pending, `decided_at` desc, limit 100.
  Photos via `createSignedUrls(paths, 3600)`. Empty: `Nothing waiting. Nice.` / `No decisions yet.`
- Claim card: 140px thumbnail (click opens a `<dialog id="zoom">` with full image), or
  `Combo - no photo needed` / `No photo`; code, name, points, rider number and name,
  `Submitted <time> by <who>` plus `- photo file time <time>`, note, and for decided claims a status
  badge, decider, time and reason.
- Pending actions: Approve (green), reason input, Deny (red). Deny without a reason focuses the input
  and warns `'Enter a reason to deny.'`. Decided: "Revert to pending". All via `rpc('scorer_decide')`.
- Auto-refresh every 20 s when the page is visible and on the Pending tab.
- Add claim tab: rider number, bonus select (all bonuses incl. penalties: `CODE - name (points)`),
  status select (Approve now / Add as pending), note, optional photo (shrunk, uploaded to `scorer/<uuid>.<ext>`),
  `rpc('scorer_add_claim')`. Help text: "For riders who could not submit themselves, penalties, or checkpoint entries."

### 5.6 `admin.html`
- Loads PapaParse. Same sign-in / not-scorer handling (`Not on the scorer list.`).
- **Event** card: event name, attempts allowed (1-10), claims open checkbox; Save updates `settings` id 1.
- **Import from CSV** card, one section per kind with file input, Import button (disabled until valid)
  and preview. Header matching is case-insensitive; first alias is the Google Sheets header:

  | Kind | Field: accepted headers | Required |
  |---|---|---|
  | riders | rider_number: `rider number`, `rider #`, `number`; name: `name`, `rider name`; email: `email` | rider_number, name |
  | bonuses | code: `bonus id`, `code`, `bonus code`; points: `points`; name: `name`, `bonus name`; description: `description`, `details` | code, points |
  | combos | combo_code: `combo id`, `combo`, `combo code`; member_code: `member bonus id`, `member`, `member code` | combo_code, member_code |

  Missing column: `Missing column: <names>. Found: <headers>`. Skip blank rows. Validation messages
  use spreadsheet row numbers (`Row <i+2>: ...`): rider number not a whole number, blank name,
  duplicate rider; bonus code format, points not a whole number, duplicate code; combo/member not an
  imported bonus (checked against the DB), combo includes itself, duplicate pair. Show up to 20 errors
  (`...and N more`) or `<n> rows look good. Click Import.`, plus an 8-row preview table.
  Normalize: emails lower case, codes upper case, bonus `sort_order` = file row order.
- Import: riders `upsert` on `rider_number` (tokens stay the same); bonuses `upsert` on `code`;
  combos delete all then insert (replaced as a whole). Result: `Imported <n> <kind>.`
  Help text: import bonuses before combos.
- **Rider links** card: table `# / Name / Link (open) / New link`; link = `rider.html?t=<token>`
  resolved against the current page URL. "Download links as CSV" (PapaParse unparse) ->
  `rider-links.csv` with `Rider Number, Name, Email, Link`. "New link" calls `scorer_new_token`.
  Empty: `Import riders first.`
- **Testing reset** card: text input `Type DELETE ALL CLAIMS`, red "Delete all claims" button ->
  `scorer_delete_all_claims`; shows `Deleted <n> claims.` Explains riders, bonuses, links and photos are kept.

### 5.7 `leaderboard.html`
Public. Title "Leader board". Table: Finish, Rider, Name, Bonuses (right), Score (right, bold), large text.
`rpc('leaderboard')`; line `Updated <time> - refreshes every 30 seconds`; refresh every 30 s when visible.

### 5.8 `styles.css`
CSS variables with light and `prefers-color-scheme: dark` palettes (bg, card, text, muted, line,
accent, ok/warn/err + backgrounds, info-bg). `[hidden] { display:none !important }`. System font 16px.
`main` max-width 860px. Classes: `.card`, `.stack`, `.row`, `.grow`, `.muted`, `.msg` (+ `.ok/.error/.warn`),
`.badge` (+ `.approved/.pending/.denied`), `.list`, `.bonus-btn`, `.bonus-code` (monospace bold),
`.photo-preview`, `.claim` (140px grid, single column under 520px), `.nav`, `.tabs` (active = filled accent),
`.table-wrap`, `.num`, `.big-board`, `.big`, button variants `.secondary/.danger/.ok/.link`,
`.score-card`, `.score-total` (2rem), `.check`, `.group-head` (uppercase muted heading).

---

## 6. Hosting and config

**`netlify.toml`**
```toml
[build]
  publish = "web"
  command = "node scripts/write-config.mjs"

[build.environment]
  SECRETS_SCAN_OMIT_KEYS = "SUPABASE_URL,SUPABASE_ANON_KEY"
```
with comments: set the two env vars in Netlify; both are public by design.

**`scripts/write-config.mjs`** (no dependencies):
- Read and trim `SUPABASE_URL`, `SUPABASE_ANON_KEY`. Missing -> exit 1 naming them.
- URL must parse with protocol http/https; else exit 1 **without echoing the value** (a pasted
  `postgresql://` string would leak the DB password). Hostname ending `supabase.com` -> exit 1
  ("dashboard address, not the project API").
- Keep only `origin` (strip pasted `/rest/v1/` etc.), warn if trimmed.
- Key containing whitespace, quotes or backslash -> exit 1.
- Write `web/config.js` with a "Generated ... Do not edit here." header. Each error includes the hint
  `Use the Project URL from Supabase -> Project Settings -> API, like https://abcd1234.supabase.co`.

**`web/serve.json`**: `{ "cleanUrls": false }` - otherwise `serve` redirects `rider.html?t=...`
to `/rider` and drops the token.

**`supabase/config.toml`**: Supabase CLI defaults with `project_id = "snafu-rally-web"`,
`[auth] site_url = "http://localhost:8080"`, `additional_redirect_urls = ["http://localhost:8080/**"]`,
email sign-in enabled. Local ports: API 54321, Studio 54323, Mailpit 54324.

---

## 7. Tests

### 7.1 `tests/supabase_stubs.sql`
Creates roles `anon`, `authenticated` (nologin) and `service_role` (bypassrls); schema `auth` with
`auth.jwt()` reading `current_setting('request.jwt.claims', true)` as jsonb (default `{}`); schema
`storage` with `buckets` and `objects` (RLS enabled), `storage.foldername(name)`; grants mirroring
Supabase defaults: schema usage, select/insert on storage.objects, default execute on functions for
anon/authenticated, **no default table grants** (schema.sql must grant itself).

### 7.2 `tests/schema.test.mjs` (PGlite)
Load stubs then the real `supabase/schema.sql`. Helpers switch role with `set role` and set
`request.jwt.claims` for scorer / non-scorer emails. Note: use `select * from fn()`, not
`select (fn()).*` (the latter calls fn once per column). Tests:
1. bonus code format is enforced
2. anon key alone cannot read tables
3. table grants: scorers can do what the admin page does; non-scorers see nothing
4. rider session lists bonuses but hides penalties
5. rider submit rules (unknown code, penalty code, photo required, wrong photo folder, retries by
   client id, max attempts, already approved)
6. photo uploads only into a real rider folder
7. only scorers can decide; status rules and audit (no approved->denied, revert, evidence locked,
   events logged)
8. scoring: combos auto-count and penalties scale the score
9. closing claims and scorer reset
10. reset.sql removes everything (then schema.sql reloads cleanly)

### 7.3 `tests/web.test.mjs` (Playwright Chromium)
- If `tmp/supabase.esm.js` is missing, bundle it:
  `npx esbuild node_modules/@supabase/supabase-js/dist/module/index.js --bundle --format=esm --platform=browser --outfile=tmp/supabase.esm.js`.
- Route `https://cdn.jsdelivr.net/**` to that bundle and `https://cdnjs.cloudflare.com/**` to
  `node_modules/papaparse/papaparse.min.js`. Serve `web/` at `http://app.test/` with a fake `config.js`
  pointing at `https://test.supabase.co`. Fake API by routing `https://test.supabase.co/**` with
  "METHOD /path" prefix handlers (longest match wins), CORS headers incl. `content-range`, and a
  recorded call list. Fail the test on page errors.
- Tests:
  1. rider: submit with photo, survives a dropped connection without re-uploading
  2. rider: combo can be sent without a photo; approved bonus is blocked; bad link explains itself
  3. rider: score at the top; claimed bonuses grouped, filtered and remembered
  4. scorer: sees pending claim with photo, deny needs a reason, approve calls the API
  5. scorer: signed-out user gets the email login; non-scorer is told so
  6. admin: CSV import validates, then upserts riders with the sheet column names
  7. leader board renders scores

All tests must pass with `npm test` before the work is called done.

---

## 8. Sample data

`samples/rider-master.csv`
```
Rider Number,Name,Email
42,Jane Smith,jane@example.com
7,Bob Jones,bob@example.com
15,Ana Diaz,ana@example.com
```
`samples/bonus-master.csv`
```
Bonus ID,POINTS,Name,Description
ABCD,100,Old mill,Photo of the water wheel with your rally flag
WXYZ,50,Covered bridge,Photo of the bridge sign
ABC1,10,Gas stop,Receipt or pump photo
ARSN,25,Mill and bridge combo,Awarded when ABCD and WXYZ are both approved
LAT1,-25,Late under 15 min,Penalty - 25 percent off
LAT2,-50,Late under 30 min,Penalty - 50 percent off
LAT3,-100,Late over 30 min,Penalty - score zeroed
```
`samples/combo-master.csv`
```
Combo ID,Member Bonus ID
ARSN,ABCD
ARSN,WXYZ
```

---

## 9. Out of scope (do not build)

- Location check against bonus coordinates. (Planned approach when resumed: capture device GPS at
  photo time in the app, since EXIF GPS is unreliable from mobile browsers; compute distance in the
  DB; flag for the scorer instead of auto-denying.)
- Offline queue that sends automatically later (today the entry stays on screen; tap Submit again).
- Printable QR codes for rider packets.
- Bonus availability windows / time checks.
- Combos of combos (one level only).
- Migrations (schema.sql is the source of truth; if migrations are added, point the DB tests at them).

---

## 10. Done when

1. `npm install && npm run test:setup && npm test` passes all 17 tests.
2. Pasting `schema.sql` into a fresh Supabase project runs without errors, and running it twice is harmless.
3. Following README setup with the `samples/` CSVs, a rider can submit from a phone, a scorer can
   approve, and the leader board shows the score (ABCD + WXYZ approved = 175 with combo ARSN).
