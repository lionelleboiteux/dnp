# DNP — Joueurs Indisponibles (Ligue 1)

A page, separate from the Wix-hosted fantasy-coach.fr, showing — for a
selected journée — which Ligue 1 players are unavailable and why (blessure,
suspension, raison personnelle, hors groupe, transfert), one card per team. Data comes
from a private Google Sheet maintained by a teammate; the sheet itself is
never published or made public.

Same $0 hosting pattern as the sibling project
[`pronos`](../pronos) (`pronos.fantasy-coach.fr`): a static page deployed via
GitHub Actions to GitHub Pages, on its own subdomain of fantasy-coach.fr. It's
simpler than `pronos` — no writes, no scheduling — so there's no
Supabase/pg_cron here.

## Architecture

```
Google Sheet (private)
      |
      v
Apps Script Web App (apps-script/Code.gs)   <-- runs as the sheet owner/editor,
      |    ^                                    reads text + cell colors
      |    | webhook on edit (worker/, see
      |    | "Cloudflare Worker cache" below)
      |    |
      v    |
Cloudflare Worker + Workers KV (worker/)    <-- edge cache; ordinary visits
      |                                          never wait on Apps Script's
      | JSON (only nom/prenom/posteFin/raison/categorie/retourPrevu — never the raw sheet)
      v
frontend/index.html (static, GitHub Pages, l1.dnp.fantasy-coach.fr)
```

The frontend talks to the Cloudflare Worker cache below, not straight to
Apps Script — it exists because Apps Script's own container spins down when
idle (a cold request can hang 10-40s), so ordinary visits go through the
Worker's Cloudflare KV cache instead of hitting Apps Script directly; the
Sheet's own edit hooks push fresh data into that cache proactively, so
nobody pays the cold-start cost.

## Setup

### 1. Attach and deploy the Apps Script

1. Open the "Stats joueur L1 - Saison 26-27" Google Sheet with an account
   that has **edit** access.
2. Extensions > Apps Script. Delete the default `Code.gs` content and paste
   in the contents of [`apps-script/Code.gs`](apps-script/Code.gs). Add a
   second file for [`apps-script/appsscript.json`](apps-script/appsscript.json)
   (Project Settings > "Show appsscript.json in editor" to expose it), or
   just apply its `webapp` settings via Deploy settings in the next step.

   Alternatively, use `clasp` — see [Updating the Apps Script with
   clasp](#updating-the-apps-script-with-clasp) below, which pushes this
   repo's `apps-script/` directory straight to the live project instead of
   copy-pasting.

3. **Calibrate the reason colors** — the exact pink/green/red hex codes the
   sheet uses aren't known yet. In the Apps Script editor, select
   `debugColors` in the function dropdown, click Run, then check
   View > Executions for the logged `text -> #hexcolor` pairs. Update
   `COLOR_INJURED`, `COLOR_PERSONAL`, `COLOR_SUSPENDED` at the top of
   `Code.gs` to match, then save.
4. Also confirm `SHEET_NAME` in `Code.gs` matches the actual tab name (it's
   currently set to `'Liste Joueur 26-27'` — this has already drifted once
   this season when the tab was renamed from `'Liste Joueur 25-26'`, which
   broke the live site until `SHEET_NAME` was updated to match; re-check
   this any time the sheet stops responding).
5. Deploy > New deployment > type **Web app**. "Execute as: **Me**",
   "Who has access: **Anyone**". Deploy and copy the Web App URL
   (`https://script.google.com/macros/s/.../exec`).
6. Sanity-check it directly in a browser:
   - `<url>?meta=1` should return a JSON array of journée names.
   - `<url>?journee=Journée 1` (URL-encode the space) should return the
     per-team unavailable-player list.

### Updating the Apps Script with clasp

This repo's `apps-script/.clasp.json` already points at the live project
(script ID `1PxsLCYHtnKT9Og_i9FdvNMpERGOqol8u37a53Cz6k4-A5wUUu4-zJVfw`), so
after editing `Code.gs` or `appsscript.json` you can push and redeploy
straight from the command line instead of copy-pasting into the Apps
Script editor:

```
npm i -g @google/clasp
clasp login                                # once per machine/account
cd apps-script
clasp push                                 # uploads Code.gs + appsscript.json
clasp deployments                          # find the deployment ID matching
                                            # the /exec URL in frontend/index.html
clasp deploy -i <deploymentId>             # points the live Web App at the
                                            # version just pushed
```

Gotchas:

- **`clasp login` needs its own account authorization.** If you're not
  already logged in as an account with edit access to the sheet, run
  `clasp logout` first, then `clasp login` again to switch accounts.
- **"User has not enabled the Apps Script API"** on push/deploy: the
  logged-in account needs to enable it once at
  https://script.google.com/home/usersettings.
- **`clasp push` skips manifest changes by default** — pass `clasp push
  --force` if `appsscript.json` itself changed (e.g. `timeZone`), otherwise
  the live manifest silently keeps its old values even though `Code.gs`
  updates fine.
- **The big one**: `appsscript.json`'s `"executeAs": "USER_DEPLOYING"`
  means the Web App runs under whichever Google account most recently
  created or updated *that specific deployment* — not necessarily the
  account that originally set it up. If you `clasp deploy` with a
  different account than before, and that account has never been through
  Google's interactive OAuth consent for this script (Sheets access,
  etc.), every request to the public `/exec` URL will start failing with a
  Drive "You need access" 403 page — for **any** version, including a
  rollback, since the problem is the identity, not the code. Fix: open the
  project in the Apps Script editor as that account and run any function
  once (e.g. select `doGet`, click Run) to trigger and accept the
  authorization prompt, then redeploy.

### 2. Cloudflare Worker cache (edge caching in front of the Apps Script API)

`worker/` is a small Cloudflare Worker that caches the Apps Script JSON API
(`?meta=1` and `?journee=...`) in Workers KV, so an ordinary visit never has
to wait on Apps Script's cold start (10-40s after the container's been idle).
The frontend fetches from the Worker instead of Apps Script directly.

Refreshing that cache is a **manual** step: the Sheet has a "⚡ Cache" menu
with a "Rafraîchir maintenant" item (`refreshCacheNow_`/`onOpen` in
`Code.gs`) the maintainer clicks after finishing a batch of edits, rather
than something that fires automatically on every edit. `refreshFixtures`'s
own (much narrower) revalidation call is unaffected — see its gotcha below
for why that one stays automatic. This is deliberate, not a missing
feature — see the first gotcha below for why.

Setup (once):

```bash
cd worker
npm install
wrangler login                          # if not already logged in
wrangler kv namespace create DNP_CACHE  # paste the printed id into wrangler.jsonc's kv_namespaces[0].id
                                         # (title just needs to be distinct account-wide;
                                         # the "binding" name in wrangler.jsonc, which the
                                         # code actually uses, stays "CACHE")
wrangler secret put REVALIDATE_SECRET   # pick a random long string
wrangler deploy
```

Then, one-time, populate the cache for every journée that already has data:

```bash
curl -X POST "https://<your-worker>.workers.dev/__warm-all?secret=<REVALIDATE_SECRET>"
```

And wire up the Apps Script side so the menu can actually reach the Worker —
in the Apps Script editor:

1. **Project Settings > Script Properties > Add script property**, twice:
   - `CACHE_WEBHOOK_URL` = `https://<your-worker>.workers.dev/__revalidate`
   - `CACHE_WEBHOOK_SECRET` = the exact same value passed to `wrangler secret put` above
2. Reload the Sheet — the "⚡ Cache" menu (built by `onOpen`) appears
   automatically, no setup function to run.
3. If this project previously had the old *automatic* per-edit trigger
   installed, run `removeCacheWebhookTrigger` once from the function
   dropdown to remove it — otherwise it keeps firing (harmlessly, since its
   handler function no longer exists) on every edit.

Gotchas:

- **Why this is a manual menu click, not automatic on every edit**:
  Cloudflare's Workers KV free tier caps **1,000 "put" operations per day
  for the whole account** — shared with the sibling
  [`compos`](../compos) project's own Worker. Almost every edit here (any
  identity column, the per-club status tab) is embedded in *every*
  journée's payload (see `readUnavailablePlayers_`/`doGet`), so there's no
  cheap way to target a revalidation to "just the affected journée" the
  way compos partially can — a fully-automatic version would revalidate
  all 34 journées + `meta` (35 puts) on close to every edit. A maintainer
  updating several players in one sitting hit the daily cap this way. One
  deliberate "Rafraîchir maintenant" click after finishing a batch of
  edits still costs the same 35 puts, but only once per session instead of
  once per edit — comfortably under the cap for realistic usage.
- **`notifyCacheWebhook_` returns `false` (and `refreshCacheNow_` shows a
  failure alert) if `CACHE_WEBHOOK_URL` or `CACHE_WEBHOOK_SECRET` is
  missing, empty, or misspelled**, or the Worker responds with anything
  other than 2xx — this used to fail completely silently before
  `notifyCacheWebhook_` returned a real success/failure signal (found the
  hard way, by temporarily adding `console.log` calls and reading them
  back from the Executions log after a real edit); the UI alert now
  surfaces exactly that class of problem immediately instead.
- **KV namespace titles are account-wide, not per-Worker** — `wrangler kv
  namespace create CACHE` fails with "already exists" if any other Worker
  on the account (e.g. the sibling [`compos`](../compos) project) already
  created one with that exact title. Pick a distinct title
  (`DNP_CACHE` here); the `binding` name your code actually references
  (`CACHE`) is independent and can stay the same across projects.
- **Cloudflare's `ctx.waitUntil()` has a hard 30-second ceiling** for the
  whole invocation (shared across every `waitUntil` call in that request).
  Apps Script's cold start alone can take up to 40s, and every manual
  refresh now targets all 34 journées + `meta` at once, so the revalidate
  webhook path uses a single, un-retried, 25s-per-target attempt, run in
  parallel via `Promise.all` (see `revalidateAll` in `worker/src/index.js`)
  rather than a sequential retry loop. Even so, some targets can still miss
  the window against a cold Apps Script instance — an accepted,
  self-correcting degradation (the next click corrects it), not a bug.
- **`refreshFixtures`'s own revalidation call stays automatic** (unlike the
  manual menu above) — it's infrequent (every 6h) and already narrowly
  targeted to just the gameweek(s) whose fixtures actually changed
  (usually 1-4 journées, see `journeeLabelForGameweek_`), so it's a minor,
  bounded contributor to the daily put quota rather than the main risk.
- **KV writes can take up to ~60s to propagate** to Cloudflare edge
  locations other than the one that handled the revalidation webhook — an
  accepted, low-impact limitation, not something worth engineering around
  at this project's traffic scale.
- Re-run `/__warm-all` any time the KV namespace is recreated, or after a
  long period with the Worker undeployed. If it also hits the
  ~50-subrequest cap partway through (visible as `"Too many subrequests by
  single Worker invocation"` in its JSON response), just hit the normal
  `GET /?journee=...` endpoint directly for whichever journées it didn't
  reach — each request is its own Worker invocation with its own budget,
  so looping over them individually (e.g. with `curl`) finishes the
  backfill.
- No automated CI deploy for the Worker (unlike the frontend's `pages.yml`)
  — `wrangler deploy` from `worker/` is manual, matching how Apps Script
  deploys are also manual via `clasp` in this repo.

### 3. Point the frontend at the Web App

Edit `frontend/index.html`'s `API_BASE` default (currently the Cloudflare
Worker's `workers.dev` URL — see [Cloudflare Worker
cache](#2-cloudflare-worker-cache-edge-caching-in-front-of-the-apps-script-api)
above) to point at your own Worker deployment. Apps Script's `/exec` URL
from step 1.6 is only used internally by the Worker (`APPS_SCRIPT_BASE` in
`worker/wrangler.jsonc`) and directly via `?api=<apps-script-url>` for
debugging. (For local testing without editing the file, append
`?api=<url>` to the page's own URL instead — same override, works against
either the Worker or Apps Script directly.)

### 4. Host it

1. Create a GitHub repo for this directory, push `main`.
2. Repo Settings > Pages > Source: **GitHub Actions** (the included
   `.github/workflows/pages.yml` handles the rest on every push to `main`).
3. Add a DNS **CNAME** record: `l1.dnp` → `<your-github-username>.github.io`
   (same as was done for `pronos.fantasy-coach.fr`).
4. Once DNS propagates and a deploy has run, https://l1.dnp.fantasy-coach.fr
   should serve the page.

## Notes

- **Caching**: two independent layers. `Code.gs`'s own `CacheService`
  (script-side, up to 6h, invalidated by bumping a version stamp on
  `onEdit`) protects `SpreadsheetApp` reads from repeat requests and
  updates automatically on every edit; the Cloudflare Worker (see
  [Cloudflare Worker
  cache](#2-cloudflare-worker-cache-edge-caching-in-front-of-the-apps-script-api)
  above) sits in front of *that*, in Workers KV, so an ordinary visit skips
  Apps Script's cold start (10-40s) entirely, not just its Sheet reads. The
  Worker's cache is invalidated **manually**, via the Sheet's "⚡ Cache"
  menu (`refreshCacheNow_`) — see the Worker section's gotchas for why.
- Sheet's fixed left-hand identity columns are, 1-indexed: A (unused/checkbox),
  B `Retour prévu` (free text, per player, not per journée), C `Nom`,
  D `Prénom`, E `Équipe`, F (unused), G `Poste fin`. These offsets are
  hardcoded as `COL_*` constants at the top of `Code.gs` — if a column is
  ever inserted/removed to the left of `Poste fin`, update those constants
  to match.
- Whenever Apps Script code changes, redeploy is manual — either via
  `clasp push` + `clasp deploy` (see [Updating the Apps Script with
  clasp](#updating-the-apps-script-with-clasp)) or Deploy > Manage
  deployments > edit > new version in the editor. This isn't wired into
  CI, unlike the frontend, since it's expected to change rarely once the
  color calibration is done.
- Any `Bless/Susp` text that doesn't match `HG`/`Susp`/one of the two
  calibrated colors comes back as category `incertain` with the raw sheet text
  shown, rather than being dropped silently.
- Per-club status pill (shown next to the club name in the header, current
  journée only): sourced from A2:B19 in the **"Mise à jour"** tab — A is the
  club name (must match `Équipe` values), B is the free-text status; row 1
  is a header. It's a flat block the maintainer overwrites for the current
  gameweek rather than one per journée, so `Code.gs` returns it on every
  journee response and `frontend/index.html` only renders it when the
  selected journée matches the live current gameweek (`STATUS_*` constants
  in `Code.gs`, `.team-status` in the frontend).
- Team logos: sourced from the pronos Supabase `teams` table and hardcoded
  in `TEAM_LOGOS` in `frontend/index.html`, matched by hand against this
  sheet's `Equipe` values. Troyes and Le Mans are this season's promoted
  clubs (confirmed directly against live pronos game data), replacing
  Metz/Nantes from the roster this map was originally built against. Any
  team name that doesn't match a key, including a future promotion/
  relegation cycle not yet reflected here, falls back to the colored
  initials badge (`teamInitials()`) — same fallback also covers any crest
  URL that 404s at runtime.
- **Default/"current" journée selection**: `frontend/index.html` does *not*
  infer this from the sheet at all. It fetches the live current Ligue 1
  gameweek from the public jeu-des-pronos API
  (`/v1/leagues/{id}/current`, same endpoint `Code.gs`'s
  `fetchCurrentGameweekNumber_` uses server-side for the Fixtures refresh)
  and defaults the dropdown to `'Journée ' + that number`, falling back to
  the first journée in the `?meta=1` list if that call fails or the
  computed label isn't in the list.
- Opponent/home-away badges (🏠/✈️ next to each team name) come from the
  pronos Supabase API's `/v1/leagues/{id}/current` endpoint, fetched
  alongside the current-gameweek lookup in `frontend/index.html`. That
  endpoint only ever returns the *live* current gameweek's fixtures — there
  is no endpoint for an arbitrary journée — so the badges only render when
  the selected journée matches `currentJourneeLabel`; any other journée
  shows no badge. Team names are matched via `PRONOS_TEAM_TO_EQUIPE`
  (pronos's full official names → this sheet's `Equipe` values), the same
  hand-matching approach as `TEAM_LOGOS`.
