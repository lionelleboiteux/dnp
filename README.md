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
      |                                          reads text + cell colors
      | JSON (only nom/prenom/posteFin/raison/categorie/retourPrevu — never the raw sheet)
      v
frontend/index.html (static, GitHub Pages, l1.dnp.fantasy-coach.fr)
```

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

### 2. Point the frontend at the Web App

Edit `frontend/index.html`, replace `REPLACE_WITH_APPS_SCRIPT_WEB_APP_URL`
with the Web App URL from step 1.6. (For local testing without editing the
file, append `?api=<url>` to the page's own URL instead.)

### 3. Host it

1. Create a GitHub repo for this directory, push `main`.
2. Repo Settings > Pages > Source: **GitHub Actions** (the included
   `.github/workflows/pages.yml` handles the rest on every push to `main`).
3. Add a DNS **CNAME** record: `l1.dnp` → `<your-github-username>.github.io`
   (same as was done for `pronos.fantasy-coach.fr`).
4. Once DNS propagates and a deploy has run, https://l1.dnp.fantasy-coach.fr
   should serve the page.

## Notes

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
  journée only): sourced from C548:D565 in the same sheet — C is the club
  name (must match `Équipe` values), D is the free-text status. It's a flat
  block the maintainer overwrites for the current gameweek rather than one
  per journée, so `Code.gs` returns it on every journee response and
  `frontend/index.html` only renders it when the selected journée matches
  the live current gameweek (`STATUS_*` constants in `Code.gs`, `.team-status`
  in the frontend).
- Team logos: sourced from the pronos Supabase `teams` table and hardcoded
  in `TEAM_LOGOS` in `frontend/index.html`, matched by hand against this
  sheet's `Equipe` values. Troyes and Le Mans are this season's promoted
  clubs (confirmed directly against live pronos game data), replacing
  Metz/Nantes from the roster this map was originally built against. Any
  team name that doesn't match a key, including a future promotion/
  relegation cycle not yet reflected here, falls back to the colored
  initials badge (`teamInitials()`) — same fallback also covers any crest
  URL that 404s at runtime.
- "Next journée to be played" (the default selection and the top of the
  dropdown) is inferred by `orderedJourneeList_()` in `Code.gs`: it scans
  the `MN` column for each journée and treats the first entirely-blank one
  as not yet played, assuming played weeks fill in left-to-right without
  gaps. If the sheet is ever updated out of order this heuristic can be
  wrong for one week until the gap is filled in.
- Opponent/home-away badges (🏠/✈️ next to each team name) come from the
  pronos Supabase API's `/v1/leagues/{id}/current` endpoint, fetched
  alongside the current-gameweek lookup in `frontend/index.html`. That
  endpoint only ever returns the *live* current gameweek's fixtures — there
  is no endpoint for an arbitrary journée — so the badges only render when
  the selected journée matches `currentJourneeLabel`; any other journée
  shows no badge. Team names are matched via `PRONOS_TEAM_TO_EQUIPE`
  (pronos's full official names → this sheet's `Equipe` values), the same
  hand-matching approach as `TEAM_LOGOS`.
