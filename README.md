# snafu-rally-web

Bonus claims and scoring for the SNAFU rally. Riders submit photos from a personal link on their
phone, scorers approve or deny in a browser, and the database enforces the rules and calculates
the leader board.

**Status: test build.** No location checks, offline queue or QR printing yet.
Full design and rules: [SPEC.md](SPEC.md).

| Page | Who | What |
|---|---|---|
| `rider.html?t=<token>` | Rider | Bonus list, score, photo submit. No login; the link is the key. |
| `scorer.html` | Scorer | Approve / deny / revert claims as photo cards or a sortable table; open a claim to compare it with the bonus reference photo; add a claim for a rider. |
| `activity.html` | Scorer | What is happening now: claim feed, which riders have opened their link, scorer sign-ins. |
| `admin.html` | Admin | Event settings, CSV import, edit riders / bonuses (with reference photo) / combos, rider links, delete all. |
| `leaderboard.html` | Anyone | Live ranking. |

## Setup (about 15 minutes)

You need a free [Supabase](https://supabase.com) account and a free [Netlify](https://netlify.com)
account connected to this GitHub repo.

**1. Database (Supabase)**

1. Create a new Supabase project.
2. SQL Editor -> New query -> paste all of `supabase/schema.sql` -> **Run**.
3. Add each scorer email (lower case). `true` makes that person an admin too (admin page);
   scorers who only review claims get `false`:
   ```sql
   insert into scorers (email, is_admin) values ('you@example.com', true);
   insert into scorers (email, is_admin) values ('helper@example.com', false);
   ```
4. Project Settings -> API: copy the **Project URL** and the **anon public** key.
5. Deploy the photo viewer for riders (Supabase Edge Function), from this repo folder:
   ```
   npx supabase login
   npx supabase functions deploy rider-photo --no-verify-jwt --project-ref <project ref>
   ```
   The project ref is the `xxxx` in `https://xxxx.supabase.co`. Without this, everything works
   except the rider's **Show photo** button.

**2. Website (Netlify)**

1. Add new site -> Import from GitHub -> pick this repo. Leave the build settings as they are
   (`netlify.toml` handles them).
2. Site configuration -> Environment variables: add `SUPABASE_URL` and `SUPABASE_ANON_KEY`
   with the values from step 1.4.
3. Deploys -> Trigger deploy. Note the site address, e.g. `https://your-rally.netlify.app`.

**3. Sign-in links (Supabase)**

Authentication -> URL Configuration:
- Site URL: your Netlify address
- Redirect URLs: add `https://your-rally.netlify.app/**`

**4. Load the rally**

1. Open `https://your-rally.netlify.app/admin.html` and sign in with your scorer email.
2. From Google Sheets, export each tab with File -> Download -> CSV.
3. Import in this order: **Riders**, **Bonuses**, **Combos**. The existing sheet headers work as is
   (`Rider Number, Name, Email` / `Bonus ID, POINTS` / `Combo ID, Member Bonus ID`).
   Not ready yet? Use the files in `samples/`.
4. **Download links as CSV** and send each rider their link.

**5. Try it:** open a rider link on your phone, submit a bonus, approve it in `scorer.html`,
and check `leaderboard.html`.

Every push to `main` redeploys the site.

## Good to know

- **The anon key is public by design.** The database only lets it use rider links, upload into
  that rider's folder and read the leader board.
- **Rider links are secrets.** Admin -> **New link** cancels a lost or shared one.
- **Scorers and admins.** Every scorer reviews claims; only admins open the admin page. Change
  someone with `update scorers set is_admin = true where email = '...'` in the SQL Editor. When you
  re-run `schema.sql` on a project made before admins existed, the scorers already there become admins.
- **Reference photos are public links.** Admins add one per bonus (Admin -> Bonuses -> Edit). Riders
  see it on the bonus page and scorers next to the rider's photo. The file names are random and only
  admins can list them, but anyone given a photo's link can open it.
- **Riders see deny reasons.** A rider opening a bonus sees each of their submissions, the photo
  (on tap) and the scorer's reason. Write reasons for the rider.
- **Start over:** Admin -> Testing reset (claims only), or run `supabase/reset.sql` then
  `supabase/schema.sql` (everything).
- **Free plans:** Supabase pauses after a week idle (resume from the dashboard, data is kept) and
  holds about 3,000 photos. Its built-in sign-in email has a low hourly limit; add SMTP under
  Authentication if you hit it. Consider Supabase Pro for the event month.

## Development

Needs Node 20+.

```
npm install
npm run test:setup   # one time: Chromium for the browser tests
npm test             # database rules (PGlite) + pages (headless Chromium)
npm run serve        # pages at http://localhost:8080
```

`web/config.js` points at local Supabase. To run against it (needs Docker):

```
npx supabase start
docker exec -i supabase_db_snafu-rally-web psql -U postgres -q < supabase/schema.sql
docker exec supabase_db_snafu-rally-web psql -U postgres -c "insert into scorers (email, is_admin) values ('you@example.com', true)"
npm run serve
```

Open http://localhost:8080/admin.html (use `localhost`, not `127.0.0.1`). Sign-in emails land in
Mailpit at http://127.0.0.1:54324; Studio is at http://127.0.0.1:54323.
To use a hosted project locally instead, put its values in `web/config.js` and do not commit them.

## License

GNU General Public License v3.0 or later. See [LICENSE](LICENSE).
