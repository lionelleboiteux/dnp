# DNP — Joueurs Indisponibles (Ligue 1)

A page, separate from the Wix-hosted fantasy-coach.fr, showing — for a
selected journée — which Ligue 1 players are unavailable and why (blessure,
suspension, raison personnelle, hors groupe), one card per team. Data comes
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
      | JSON (only nom/prenom/posteFin/raison/categorie — never the raw sheet)
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

   Alternatively, if you have [`clasp`](https://github.com/google/clasp)
   installed and are logged in (`npm i -g @google/clasp && clasp login`),
   you can push this repo's `apps-script/` directory directly instead of
   copy-pasting:
   ```
   cd apps-script
   clasp create --type sheets --parentId <SPREADSHEET_ID> --rootDir .
   clasp push
   ```

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

- Whenever Apps Script code changes, redeploy is manual (Deploy > Manage
  deployments > edit > new version) — this isn't wired into CI, unlike the
  frontend, since it's expected to change rarely once the color calibration
  is done.
- Any `Bless/Susp` text that doesn't match `HG`/`Susp`/one of the two
  calibrated colors comes back as category `autre` with the raw sheet text
  shown, rather than being dropped silently.
- Team logos: sourced from the pronos Supabase `teams` table and hardcoded
  in `TEAM_LOGOS` in `frontend/index.html`, matched by hand against this
  sheet's `Equipe` values. Metz and Nantes aren't in that table (it has
  stale entries for Troyes/Le Mans FC, from before a promotion/relegation
  cycle) and fall back to the colored initials badge (`teamInitials()`)
  until a source is found for them; the same fallback also covers any
  crest URL that 404s at runtime.
- "Next journée to be played" (the default selection and the top of the
  dropdown) is inferred by `orderedJourneeList_()` in `Code.gs`: it scans
  the `MN` column for each journée and treats the first entirely-blank one
  as not yet played, assuming played weeks fill in left-to-right without
  gaps. If the sheet is ever updated out of order this heuristic can be
  wrong for one week until the gap is filled in.
