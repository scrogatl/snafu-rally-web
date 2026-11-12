# snafu-rally-web

Bonus claims and scoring for the SNAFU rally, without email subject lines or spreadsheet formulas.
Riders submit from a personal link on their phone; scorers review in a browser; the database
enforces the rules and calculates the leader board.

**Status: barebones test build.** Location checks, offline queueing and QR printing are not in yet
(see [Not in this build](#not-in-this-build)).

```
Rider phone (personal link)              Scorer laptop / phone (email sign-in)
  pick bonus -> photo -> Submit             pending queue -> Approve / Deny / Revert
        |                                          |
        v                                          v
  Supabase: Postgres (rules, audit, scores) + Storage (photos, private bucket)
        |
        v
  Leader board (public page, live)
```

## Pages (`web/`)

| Page | Who | What |
|---|---|---|
| `rider.html?t=<token>` | Rider | Bonus list with status, search, photo submit. No login; the link is the key. |
| `scorer.html` | Scorer | Pending queue with photos, approve/deny with reason, decided list with revert, add a claim for a rider. |
| `admin.html` | Scorer | Event settings, CSV import (riders, bonuses, combos), rider links export, testing reset. |
| `leaderboard.html` | Anyone | Live ranking, refreshes every 30 seconds. |

Plain HTML and JavaScript, no build step. Host the `web/` folder anywhere that serves static files.

## Rules the database enforces

These used to depend on people typing things correctly. Now they can't be broken from the app.

| Rule | Where |
|---|---|
| Bonus code is 4 letters, or 3 letters + 1 digit | `bonuses.code` check |
| Rider identity comes from their link, not an email address | `rider_session` / `rider_submit` |
| Rider picks a bonus from the list; unknown or penalty codes are rejected | `rider_submit` |
| Photo required, except for combos | `rider_submit` |
| Max attempts per bonus (default 3, set in Admin) | `rider_submit` |
| No new claims once a bonus is approved | `rider_submit` |
| A bonus can be approved only once per rider | unique index `claims_one_approved` |
| Status moves pending -> approved/denied, and back to pending only (revert) | `claims_before_write` trigger |
| Photo, rider and bonus on a claim can't be edited after submit | `claims_before_write` trigger |
| Every submit, decision and revert is logged with who and when | `claim_events` |
| A tapped-twice or retried submit never creates a duplicate | `claims.client_id` |
| Riders can upload photos only into their own folder; only scorers can view photos | storage policies |
| Only emails in `scorers` can see or change anything | row level security |

**Scoring** matches the current sheet: sum of approved positive bonuses, then
`x (1 + worst approved penalty / 100)`. A combo counts when all its members are approved
or the combo itself is approved (never twice). Penalty bonuses (negative points) are hidden
from riders; scorers add them with **Add claim**.

## Set up for testing (about 15 minutes)

1. **Create a Supabase project** at supabase.com (free plan is fine).
2. **Create the database:** SQL Editor -> New query -> paste all of `supabase/schema.sql` -> Run.
3. **Add yourself as a scorer** (same SQL Editor):
   ```sql
   insert into scorers (email) values ('you@example.com');
   ```
   Use lower case. Repeat for each scorer.
4. **Sign-in links:** Authentication -> URL Configuration
   - Site URL: where you'll host the pages (for local testing `http://localhost:8080`)
   - Redirect URLs: add `http://localhost:8080/**` and your hosted address with `/**`
5. **Connect the pages:** Project Settings -> API has the Project URL and the `anon` `public` key.
   - Hosted on Netlify from GitHub (recommended): New site -> Import from GitHub -> this repo. The
     included `netlify.toml` sets the publish folder (`web`) and build command. Under Site configuration
     -> Environment variables add `SUPABASE_URL` and `SUPABASE_ANON_KEY`; the build writes
     `web/config.js` from them. Every push to `main` redeploys.
   - Running the pages on your computer against the hosted project: put the two values into
     `web/config.js` (but do not commit them; the committed file points at local Supabase).
6. **Run it:**
   - On your computer: `npm run serve` (or `python3 -m http.server 8080 -d web`), then open
     http://localhost:8080/admin.html
   - On phones: phones need an https address, so use the Netlify site. Add its address to the
     Redirect URLs in step 4.
7. **Load your rally data:** in Google Sheets, export each tab with File -> Download -> CSV, then in
   Admin import **Riders**, then **Bonuses**, then **Combos**. Your existing column headers work as is
   (`Rider Number, Name, Email` / `Bonus ID, POINTS` / `Combo ID, Member Bonus ID`). Optional extra
   bonus columns: `Name`, `Description` (shown to riders). Try `samples/` first if you like.
8. **Get rider links:** Admin -> Download links as CSV. Open one on your phone and submit a bonus,
   then approve it on `scorer.html` and watch `leaderboard.html`.

To start testing over: Admin -> Testing reset (claims only), or run `supabase/reset.sql` then
`schema.sql` again (everything).

## Things to know

- **The anon key is public by design.** All it can do is call the rider functions with a valid
  token, upload into that rider's folder, and read the leader board.
- **Rider links are secrets.** Anyone with a rider's link can submit as that rider. Admin -> New link
  cancels an old one.
- **Photos are shrunk on the phone** (about 1600 px, roughly 300 KB) before upload. Photo metadata is not kept.
- **Free plan:** projects pause after a week with no activity (resume from the dashboard, data is
  kept); 1 GB of file storage, roughly 3,000 shrunk photos. For the event itself consider Pro for a month.
- **Sign-in emails** use Supabase's built-in mail sender, which has a low hourly limit. Fine for a few
  scorers; add your own SMTP under Authentication settings if you hit it.
- **Bonuses can be added or changed any time**, including mid-event. Removing a bonus that has claims
  is blocked on purpose.

## Not in this build

- Location check against the bonus location (tabled; needs bonus coordinates and capture-time GPS)
- Saving a submission on the phone to send automatically later (today: the entry is kept on screen; tap Submit again)
- Printable QR codes for rider packets (use the links CSV with any QR mail-merge for now)
- Bonus availability windows / time checks
- Combos made of other combos (one level only)

## Development

```
npm install
npm run test:setup  # one time, Chromium for the browser tests
npm test            # database rules in an in-process Postgres + pages in headless Chromium
npm run test:db     # database tests only
```

### Local Supabase (needs Docker)

The committed `web/config.js` points at local Supabase, and `supabase/config.toml` allows sign-in
links back to `http://localhost:8080`.

```
npx supabase start
docker exec -i supabase_db_snafu-rally-web psql -U postgres -q < supabase/schema.sql
docker exec supabase_db_snafu-rally-web psql -U postgres -c "insert into scorers (email) values ('you@example.com')"
npm run serve
```

- Sign-in emails are not really sent; open the local mail viewer (Mailpit) at http://127.0.0.1:54324.
- Database browser (Studio): http://127.0.0.1:54323.
- `npx supabase db reset` empties the database; load `schema.sql` and add your scorer email again.
- Use `localhost` (not `127.0.0.1`) in the browser so the sign-in link returns to the same site.
- `web/serve.json` turns off `serve`'s clean URLs, which would otherwise redirect
  `rider.html?t=...` to `/rider` and drop the rider token.

- `tests/schema.test.mjs` runs the real `supabase/schema.sql` in PGlite with small stand-ins for
  Supabase's auth and storage schemas (`tests/supabase_stubs.sql`), switching between the anon,
  rider, non-scorer and scorer roles.
- `tests/web.test.mjs` loads the real pages in Chromium (Playwright) against a fake Supabase API and
  checks the rider submit and retry flow, photo shrinking, scorer review, admin CSV import and the
  leader board.

## Files

| Path | Purpose |
|---|---|
| `supabase/schema.sql` | Tables, rules, scoring views, functions, security, photo bucket |
| `supabase/reset.sql` | Removes everything schema.sql created |
| `supabase/config.toml` | Local Supabase settings (sign-in redirect to localhost:8080) |
| `web/config.js` | Supabase URL and anon key (committed: local; hosted build overwrites it) |
| `web/serve.json` | Keeps `npm run serve` from dropping the `?t=` rider token |
| `netlify.toml`, `scripts/write-config.mjs` | Netlify build: writes `web/config.js` from environment variables |
| `web/lib.js` | Shared code: Supabase client, photo shrinking, sign-in, messages |
| `web/*.html`, `web/styles.css` | The four pages |
| `samples/*.csv` | Example data in the same shape as the Google Sheets tabs |
| `tests/` | Automated tests |

## License

GNU General Public License v3.0 or later, same as snafu-rally-scoring. See [LICENSE](LICENSE).
