/**
 * DNP — L1 unavailable players API.
 *
 * Bound to the Google Sheet "Stats joueur L1 - Saison 26-27". Deployed as a
 * Web App (Deploy > New deployment > Web app), "Execute as: Me",
 * "Who has access: Anyone" — this lets an anonymous visitor's browser read
 * data derived from the sheet without the sheet itself being shared or
 * published. Only the fields returned below ever leave the sheet.
 *
 * Endpoints (all GET, no auth):
 *   ?meta=1            -> ["Journée 1", "Journée 2", ..., "Journée 34"] (chronological;
 *                         the frontend decides which one is "current" via the
 *                         jeu-des-pronos API, not this list's order)
 *   ?journee=Journée 12 -> { equipes: [{ equipe, statut, fixture, joueurs: [{nom, prenom, posteFin, raison, categorie, retourPrevu}] }],
 *                            lastUpdated: ISO datetime | null }
 *                         `statut` is a free-text per-club status note (see
 *                         readClubStatuses_ below) — it's a flat, unversioned
 *                         block the sheet maintainer overwrites each
 *                         gameweek rather than one per journée, so it's
 *                         included on every journee response and it's up to
 *                         the frontend to only display it next to the live
 *                         current gameweek (it's meaningless, and possibly
 *                         stale, for any other journée).
 *                         `fixture` is { opponent, isHome, kickoff } | null,
 *                         read from the "Fixtures" sheet tab (see
 *                         readFixturesForGameweek_), kept up to date by a 6h
 *                         trigger (refreshFixtures/setupFixturesTrigger)
 *                         that fetches from ma-api.ligue1.fr — never live on
 *                         this request path. Available for every journée,
 *                         not just the current one (unlike `statut` above).
 *                         `lastUpdated` is when cacheVersion was last
 *                         bumped (any edit to "Liste Joueur 26-27" or
 *                         "Mise à jour", or a fixtures refresh) — see
 *                         lastUpdatedIso_.
 *   ?risqueSuspension=Journée 5 -> { equipes: [{ equipe, joueurs: [{nom, prenom, posteFin, raison}] }],
 *                         lastUpdated: ISO datetime | null }
 *                         Players at risk of being suspended for that
 *                         gameweek: the Journée's Carton column reads
 *                         CARTON_SUSPENDED_VALUE ("S", already suspended
 *                         for it) OR the single, fixed "Suivi suspension"
 *                         tracking column (found by header text, not a
 *                         hardcoded column — see findSuiviSuspensionColumn_)
 *                         reads SUIVI_SUSPENSION_THRESHOLD (4, about to be
 *                         suspended by card accumulation). `raison` is a
 *                         short French label saying which (or both) —
 *                         see readPlayersAtRiskOfSuspension_. Powers
 *                         frontend/suspensionsProchainJaune.html.
 *   ?matchsSelection=1 -> { equipes: [{ equipe, joueurs: [{nom, prenom, posteFin,
 *                         selection, matchs: [{opponent, isHome, date}]}] }],
 *                         countries: [PAYS strings, sorted],
 *                         lastUpdated: ISO datetime | null }
 *                         Players with "Dans la liste" checked (col 146),
 *                         grouped by club, each with their "Sélection"
 *                         (col 145, PAYS format) and that selection's
 *                         fixtures for the current international break,
 *                         read from the "Selections fixtures" tab (Country
 *                         | Opponent 1..4, English names, each cell shaped
 *                         "Opponent [icon] — DD Mon") and joined via
 *                         englishCountryForSelection_ -- see
 *                         readPlayersInSelection_/readSelectionsFixtures_.
 *                         `isHome` is true/false/null (fixture found but
 *                         no home/away icon on it). `date` is the raw
 *                         "DD Mon" string from the cell, or null if the
 *                         cell had no trailing date. No journée/break
 *                         picker -- always whatever's currently in that
 *                         tab. Powers frontend/matchs-en-selection.html.
 *
 * Responses are cached in CacheService (script-wide, up to 6h) so repeat
 * requests skip the SpreadsheetApp reads entirely. The cache is invalidated
 * by bumping a version stamp in PropertiesService whenever the sheet is
 * edited (see onEdit below) — that changes every cache key at once, so
 * stale entries just age out rather than needing to be deleted.
 */

// Confirmed against the live sheet (debugColors() for red, manual cell
// checks on Arcus/"Musculaire" and Mensah/"Paternité" for the other two).
var COLOR_INJURED = '#ff00ff';
var COLOR_PERSONAL = '#42ff40';
var COLOR_SUSPENDED = '#ff0000';

var SHEET_NAME = 'Liste Joueur 26-27';

// Identity columns, 1-indexed, matching the sheet's fixed left-hand columns.
var COL_RETOUR_PREVU = 2;
var COL_NOM = 3;
var COL_PRENOM = 4;
var COL_EQUIPE = 5;
var COL_POSTE_FIN = 7;

// Data rows start after the two header rows (main label row + Carton/MN/Bless-Susp sub-header row).
var FIRST_DATA_ROW = 3;

// Per-club status block, its own tab: A = club name (matches COL_EQUIPE
// values), B = free-text status note. Row 1 is a header; row 2 onward is a
// flat 18-row block (one per Ligue 1 club) the maintainer overwrites for
// the current gameweek rather than one per journée — see
// readClubStatuses_.
var SHEET_NAME_STATUS = 'Mise à jour';
var STATUS_FIRST_ROW = 2;
var STATUS_LAST_ROW = 19;
var STATUS_COL_EQUIPE = 1;
var STATUS_COL_TEXT = 2;

// Suspension-risk endpoint (see doGet's ?risqueSuspension= docs above and
// readPlayersAtRiskOfSuspension_/findSuiviSuspensionColumn_ below).
// SUIVI_SUSPENSION_HEADER is looked up by header text each time rather
// than a hardcoded column number (confirmed live at col 136 on 2026-09-17,
// but that shifts if columns are ever inserted/removed before it) — do
// NOT match on "suspension" alone, "Journée de suspension" a few columns
// over also contains that word but holds unrelated data (confirmed via
// debugUpcomingSuspensions, which matched the wrong one on a first pass).
var CARTON_SUSPENDED_VALUE = 'S';
var CARTON_SUSPENDED_LABEL = 'En sursis après un rouge';
var SUIVI_SUSPENSION_HEADER = 'Suivi suspension';
var SUIVI_SUSPENSION_THRESHOLD = 4;

// CacheService's own cap; also used as a safety-net TTL in case an edit
// somehow doesn't trigger onEdit below.
var CACHE_TTL_SECONDS = 21600;

// Bump whenever doGet's *response shape* changes (a field added/removed/
// renamed) or any other change to what a request returns for otherwise
// unchanged sheet data (e.g. a new sort order) -- distinct from
// cacheVersion (which tracks *data* changes via onEdit/refreshFixtures).
// A code deploy alone doesn't touch cacheVersion,
// so a journée whose cache entry happened to still be warm from before the
// deploy would otherwise keep serving the old shape for up to
// CACHE_TTL_SECONDS regardless of any code change (observed directly on
// the sibling compos project when adding a `lastUpdated` field left one
// still-warm journée serving a response with no `lastUpdated` at all, while
// others had already expired/recomputed). Bumping this forces every entry
// to recompute on the next request after a shape change, independent of
// edits.
var CACHE_SCHEMA_VERSION = 6;

function doGet(e) {
  if (e.parameter.matchsSelection) {
    var msCached = cacheGet_('matchsSelection');
    if (msCached !== null) {
      return jsonResponseRaw_(msCached);
    }
    var msPayload = readPlayersInSelection_();
    msPayload.lastUpdated = lastUpdatedIso_();
    var msJson = JSON.stringify(msPayload);
    cacheSet_('matchsSelection', msJson);
    return jsonResponseRaw_(msJson);
  }

  var journee = e.parameter.journee;
  var risqueSuspension = e.parameter.risqueSuspension;
  var cacheKey = risqueSuspension ? 'risque:' + risqueSuspension
    : (journee ? 'journee:' + journee : 'meta');

  var cached = cacheGet_(cacheKey);
  if (cached !== null) {
    return jsonResponseRaw_(cached);
  }

  var sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  var journeeMap = buildJourneeColumnMap_(sheet);

  var payload;
  if (risqueSuspension) {
    var riskCols = journeeMap[risqueSuspension];
    if (!riskCols) {
      return jsonResponse_({ error: 'Journée inconnue: ' + risqueSuspension });
    }
    payload = {
      equipes: readPlayersAtRiskOfSuspension_(sheet, riskCols.mn - 1),
      lastUpdated: lastUpdatedIso_()
    };
  } else if (!journee) {
    // Object key order is insertion order, i.e. chronological (left-to-right
    // in the sheet) — see buildJourneeColumnMap_.
    payload = Object.keys(journeeMap);
  } else {
    var cols = journeeMap[journee];
    if (!cols) {
      return jsonResponse_({ error: 'Journée inconnue: ' + journee });
    }
    var equipes = readUnavailablePlayers_(sheet, cols);
    var statuses = readClubStatuses_();
    var targetGw = gameweekNumberFromJournee_(journee);
    var fixturesByEquipe = isNaN(targetGw) ? {} : readFixturesForGameweek_(targetGw);
    equipes.forEach(function (team) {
      team.statut = statuses[team.equipe] || '';
      team.fixture = fixturesByEquipe[team.equipe] || null;
    });
    payload = { equipes: equipes, lastUpdated: lastUpdatedIso_() };
  }

  var json = JSON.stringify(payload);
  cacheSet_(cacheKey, json);
  return jsonResponseRaw_(json);
}

/**
 * Simple trigger — fires automatically on any edit to the bound sheet, no
 * installable-trigger setup needed. Bumping the version stamp changes every
 * cache key derived from it, which invalidates the whole cache in one write
 * without needing to know which keys currently exist. Deliberately does
 * NOT also notify the Cloudflare Worker cache here — see the "⚡ Cache"
 * menu section below for why that's a manual, not automatic, step.
 */
function onEdit(e) {
  PropertiesService.getScriptProperties().setProperty('cacheVersion', String(Date.now()));
}

function getCacheVersion_() {
  var v = PropertiesService.getScriptProperties().getProperty('cacheVersion');
  return v || '0';
}

// ISO timestamp of the last time cacheVersion was bumped (any edit to
// "Liste Joueur 26-27" or "Mise à jour" via onEdit, or a fixtures refresh)
// -- reusing cacheVersion's own millisecond stamp rather than something
// like DriveApp's file-modified time, which would need a new OAuth scope
// this project has never requested and could break the deployed web app
// until re-authorized (see README's "executeAs: USER_DEPLOYING" gotcha for
// the same class of problem). null before the very first edit this script
// has ever seen.
function lastUpdatedIso_() {
  var v = parseInt(getCacheVersion_(), 10);
  return v ? new Date(v).toISOString() : null;
}

function cacheGet_(key) {
  return CacheService.getScriptCache().get('s' + CACHE_SCHEMA_VERSION + ':v' + getCacheVersion_() + ':' + key);
}

function cacheSet_(key, value) {
  CacheService.getScriptCache().put('s' + CACHE_SCHEMA_VERSION + ':v' + getCacheVersion_() + ':' + key, value, CACHE_TTL_SECONDS);
}

// --- Cloudflare Worker cache webhook -------------------------------------
//
// Separate from (and in addition to) this script's own CacheService/
// cacheVersion mechanism above: worker/src/index.js keeps its own KV-backed
// copy of doGet's responses so visitors get an instant edge hit instead of
// waiting on this script's cold start. This notifies it when data changes
// so it can proactively re-fetch and re-cache it.
//
// Deliberately MANUAL, not automatic on every edit -- each revalidation
// costs one Workers KV "put" per journée it re-fetches, and this project
// can't target which journée(s) a given edit actually affects cheaply
// enough to matter: nearly every edit here (any identity column, the
// per-club status tab) is embedded in EVERY journée's payload, so a
// fully-automatic version would revalidate all 34 journées + meta
// (35 puts) on close to every single edit. Cloudflare's free tier caps
// Workers KV at 1,000 puts/day for the whole account -- shared with the
// sibling compos project's own Worker -- and a maintainer updating several
// players in one sitting blew through that in a single day. One deliberate
// manual refresh after finishing a batch of edits still costs the same 35
// puts, but only once per session instead of once per edit.
//
// Two ways to trigger it, both doing the exact same full refresh:
//   - A "⚡ Cache" Sheet menu (onOpen/refreshCacheNow_ below) -- desktop/web
//     only, Apps Script custom menus don't exist on the Sheets mobile app.
//   - A checkbox cell in its own "⚡ Cache" tab (onEditCacheTrigger_/
//     setupCacheRefreshTrigger below) -- an ordinary spreadsheet edit, so
//     it works identically on mobile and desktop.

/**
 * Simple trigger — adds a "⚡ Cache" menu to the Sheet's UI on open, with
 * a single "Rafraîchir maintenant" item wired to refreshCacheNow_ below.
 * Building a menu itself needs no authorization (unlike onEdit, which is
 * why this doesn't also try to auto-refresh on open) -- only actually
 * clicking the item does, prompting for consent the first time. Has no
 * effect on the Sheets mobile app, which doesn't render Apps Script custom
 * menus at all -- see onEditCacheTrigger_ below for the mobile-compatible
 * equivalent.
 */
function onOpen(e) {
  SpreadsheetApp.getUi()
    .createMenu('⚡ Cache')
    .addItem('Rafraîchir maintenant', 'refreshCacheNow_')
    .addToUi();
}

/**
 * Manual "push" for the Cloudflare Worker cache: revalidates every known
 * journée + meta in one go (see notifyCacheWebhook_/allKnownJournees_) and
 * reports success/failure via a UI alert. Run this from the "⚡ Cache" menu
 * (see onOpen above) after finishing a batch of edits, not per edit.
 */
function refreshCacheNow_() {
  var ui = SpreadsheetApp.getUi();
  var ok = notifyCacheWebhook_(allKnownJournees_());
  ui.alert(ok
    ? 'Cache en cours de rafraîchissement (jusqu\'à ~30 secondes pour se propager).'
    : 'Échec du rafraîchissement — vérifiez CACHE_WEBHOOK_URL / CACHE_WEBHOOK_SECRET ' +
      'dans Project Settings > Script Properties, ou réessayez.');
}

// A checkbox cell, not a menu, so it also works on the Sheets mobile app
// (see the comment block above). Its own tab, kept separate from the main
// sheet, so an accidental tap/edit next to it can't collide with real data.
var SHEET_NAME_CACHE_TRIGGER = '⚡ Cache';
var CACHE_TRIGGER_CELL = 'B2';

/**
 * Creates the "⚡ Cache" tab (if missing) with a label and a checkbox in
 * CACHE_TRIGGER_CELL, leaving the checkbox's current value alone if the
 * tab already exists. Called by setupCacheRefreshTrigger below; also safe
 * to call by hand if the tab or checkbox ever gets deleted by mistake.
 */
function getOrCreateCacheTriggerSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(SHEET_NAME_CACHE_TRIGGER);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME_CACHE_TRIGGER);
  sheet.getRange('A2').setValue('Cocher pour rafraîchir le cache (le calcul peut prendre ~30 secondes) :');
  var box = sheet.getRange(CACHE_TRIGGER_CELL);
  if (typeof box.getValue() !== 'boolean') {
    box.insertCheckboxes();
    box.setValue(false);
  }
  return sheet;
}

/**
 * Installable-trigger counterpart to onEdit above — unlike a simple
 * trigger, this runs with full authorization and can call UrlFetchApp (via
 * notifyCacheWebhook_). Registered by setupCacheRefreshTrigger below. Only
 * reacts to CACHE_TRIGGER_CELL in the "⚡ Cache" tab being checked; every
 * other edit anywhere else in the spreadsheet is ignored, so this doesn't
 * reintroduce automatic revalidation on ordinary data edits — see the
 * comment block above for why that's the whole point. Reads the cell's
 * current value directly (rather than trusting `e.value`, which Apps
 * Script only populates for single-cell edits) so a multi-cell paste that
 * happens to cover this cell is still handled correctly.
 */
function onEditCacheTrigger_(e) {
  if (!e || !e.range) return;
  var sheet = e.range.getSheet();
  if (!sheet || sheet.getName() !== SHEET_NAME_CACHE_TRIGGER) return;
  if (e.range.getA1Notation() !== CACHE_TRIGGER_CELL) return;

  var box = sheet.getRange(CACHE_TRIGGER_CELL);
  if (box.getValue() !== true) return; // only react to checking it, not unchecking

  var ok = notifyCacheWebhook_(allKnownJournees_());
  box.setValue(false); // script-driven write -- doesn't itself re-fire onEdit
  SpreadsheetApp.getActiveSpreadsheet().toast(
    ok ? 'Cache rafraîchi (jusqu\'à ~30 secondes pour se propager).' : 'Échec du rafraîchissement du cache.',
    '⚡ Cache'
  );
}

/**
 * One-time setup: run this once from the Apps Script editor (select it in
 * the function dropdown, click Run, grant the requested permissions) to
 * create the "⚡ Cache" tab/checkbox if missing and install the
 * installable trigger above. Re-running is safe — it removes any trigger
 * it previously installed for onEditCacheTrigger_ first, so this never
 * stacks up duplicates.
 */
function setupCacheRefreshTrigger() {
  getOrCreateCacheTriggerSheet_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onEditCacheTrigger_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onEditCacheTrigger_').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();
}

/**
 * One-time cleanup: run this once from the Apps Script editor to remove
 * the old per-edit installable trigger from before the "⚡ Cache" menu/
 * checkbox replaced it (see the comment block above) — it would otherwise
 * keep firing on every edit, pointing at a handler function that no longer
 * exists. Safe to run even if that trigger was already removed (no-op).
 */
function removeCacheWebhookTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onEditCacheWebhook_') ScriptApp.deleteTrigger(t);
  });
}

/**
 * POSTs to the Worker's /__revalidate endpoint with the journée(s) that
 * changed. CACHE_WEBHOOK_URL/CACHE_WEBHOOK_SECRET are Script Properties
 * (Project Settings > Script Properties in the editor — never committed
 * here, and clasp has no CLI for setting them). Silently no-ops (returns
 * false) if either is unset, so this feature is safe to leave
 * unconfigured. Wrapped in try/catch so a Worker outage/timeout never
 * surfaces as an uncaught error — worst case is a stale edge cache entry
 * until the next successful call. Returns true only on a confirmed 2xx
 * response, so refreshCacheNow_ can report real success/failure rather
 * than just "request sent."
 */
function notifyCacheWebhook_(journees) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('CACHE_WEBHOOK_URL');
  var secret = props.getProperty('CACHE_WEBHOOK_SECRET');
  if (!url || !secret || !journees || !journees.length) return false;

  try {
    var resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Revalidate-Secret': secret },
      payload: JSON.stringify({ journees: journees }),
      muteHttpExceptions: true
    });
    return resp.getResponseCode() >= 200 && resp.getResponseCode() < 300;
  } catch (err) {
    console.error('notifyCacheWebhook_ failed', err);
    return false;
  }
}

// Every journée the Worker should revalidate -- built from the same source
// doGet's own ?meta=1 response uses (buildJourneeColumnMap_), so it never
// drifts from what's actually in the sheet.
function allKnownJournees_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  return Object.keys(buildJourneeColumnMap_(sheet));
}

/**
 * Row 1 holds journée/round labels (e.g. "Journée 12", "CDF 32ème") in
 * merged cells spanning 3 columns; row 2 holds the sub-headers
 * "Carton", "MN", "Bless/Susp" under each. This scans row 2 for that
 * 3-column pattern and reads the label from row 1, falling back to the
 * nearest non-empty cell to the left to handle the merge (getValues()
 * only returns a value in the merge's top-left cell).
 */
function buildJourneeColumnMap_(sheet) {
  var lastCol = sheet.getLastColumn();
  var row1 = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var row2 = sheet.getRange(2, 1, 1, lastCol).getValues()[0];

  var map = {};
  for (var c = 0; c < lastCol - 2; c++) {
    if (row2[c] === 'Carton' && row2[c + 1] === 'MN' && row2[c + 2] === 'Bless/Susp') {
      var label = row1[c];
      if (!label) {
        for (var back = c - 1; back >= 0 && back >= c - 2; back--) {
          if (row1[back]) {
            label = row1[back];
            break;
          }
        }
      }
      if (label) {
        // +1: sheet.getRange is 1-indexed, our loop index c is 0-indexed.
        map[label] = { mn: c + 2, blessSusp: c + 3 };
      }
    }
  }
  return map;
}

function readUnavailablePlayers_(sheet, cols) {
  var lastRow = sheet.getLastRow();
  var numRows = lastRow - FIRST_DATA_ROW + 1;
  if (numRows <= 0) return [];

  var identity = sheet.getRange(FIRST_DATA_ROW, 1, numRows, COL_POSTE_FIN).getValues();
  var blessSuspRange = sheet.getRange(FIRST_DATA_ROW, cols.blessSusp, numRows, 1);
  var texts = blessSuspRange.getValues();
  var colors = blessSuspRange.getBackgroundColors();

  var byTeam = {};
  for (var i = 0; i < numRows; i++) {
    var text = String(texts[i][0] || '').trim();
    if (!text) continue;

    var nom = identity[i][COL_NOM - 1];
    var equipe = identity[i][COL_EQUIPE - 1];
    if (!nom || !equipe) continue; // skip malformed/incomplete rows

    var player = {
      nom: nom,
      prenom: identity[i][COL_PRENOM - 1],
      posteFin: identity[i][COL_POSTE_FIN - 1],
      raison: text,
      categorie: classify_(text, colors[i][0]),
      retourPrevu: String(identity[i][COL_RETOUR_PREVU - 1] || '').trim()
    };

    if (!byTeam[equipe]) byTeam[equipe] = [];
    byTeam[equipe].push(player);
  }

  return Object.keys(byTeam).sort().map(function (equipe) {
    // Unavailable ("out": blessure/suspendu/personnel/hors_groupe/transfert)
    // first, then incertain, then disponible last -- Array#sort is stable
    // in the V8 runtime Apps Script uses, so players within the same
    // category keep their original (sheet row) order.
    var joueurs = byTeam[equipe].sort(function (a, b) {
      return categorySortRank_(a.categorie) - categorySortRank_(b.categorie);
    });
    return { equipe: equipe, joueurs: joueurs };
  });
}

/**
 * Players at risk of suspension for one journée: Carton reads
 * CARTON_SUSPENDED_VALUE (already suspended for it) OR the "Suivi
 * suspension" column reads SUIVI_SUSPENSION_THRESHOLD (about to be
 * suspended by accumulation) -- see doGet's ?risqueSuspension= docs above.
 * `raison` names which one(s) matched, in French, so the frontend can
 * display it as-is without knowing the underlying rule.
 */
function readPlayersAtRiskOfSuspension_(sheet, cartonCol) {
  var lastRow = sheet.getLastRow();
  var numRows = lastRow - FIRST_DATA_ROW + 1;
  if (numRows <= 0) return [];

  var suiviCol = findSuiviSuspensionColumn_(sheet);

  var identity = sheet.getRange(FIRST_DATA_ROW, 1, numRows, COL_POSTE_FIN).getValues();
  var carton = sheet.getRange(FIRST_DATA_ROW, cartonCol, numRows, 1).getValues();
  var suivi = suiviCol ? sheet.getRange(FIRST_DATA_ROW, suiviCol, numRows, 1).getValues() : null;

  var byTeam = {};
  for (var i = 0; i < numRows; i++) {
    var nom = identity[i][COL_NOM - 1];
    var equipe = identity[i][COL_EQUIPE - 1];
    if (!nom || !equipe) continue; // skip malformed/incomplete rows

    var cartonVal = String(carton[i][0] || '').trim();
    var suiviVal = suivi ? suivi[i][0] : null;
    var viaCarton = cartonVal === CARTON_SUSPENDED_VALUE;
    var viaSuivi = suivi !== null && Number(suiviVal) === SUIVI_SUSPENSION_THRESHOLD;
    if (!viaCarton && !viaSuivi) continue;

    var raisons = [];
    if (viaCarton) raisons.push(CARTON_SUSPENDED_LABEL);
    if (viaSuivi) raisons.push('Suivi suspension (' + suiviVal + ')');

    var player = {
      nom: nom,
      prenom: identity[i][COL_PRENOM - 1],
      posteFin: identity[i][COL_POSTE_FIN - 1],
      raison: raisons.join(' + ')
    };

    if (!byTeam[equipe]) byTeam[equipe] = [];
    byTeam[equipe].push(player);
  }

  return Object.keys(byTeam).sort().map(function (equipe) {
    return { equipe: equipe, joueurs: byTeam[equipe] };
  });
}

// Locates the single, fixed "Suivi suspension" column by exact header
// match in row 1 or 2 (same rows buildJourneeColumnMap_ already reads for
// the per-journée groups) rather than a hardcoded column number, since
// it's outside those groups and could shift if columns are ever
// inserted/removed before it. Returns null if the header is ever renamed
// or removed -- callers then skip the "Suivi suspension" half of the
// check rather than erroring, so Carton-based results still come through.
function findSuiviSuspensionColumn_(sheet) {
  var lastCol = sheet.getLastColumn();
  var row1 = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var row2 = sheet.getRange(2, 1, 1, lastCol).getValues()[0];
  for (var c = 0; c < lastCol; c++) {
    if (String(row1[c] || '').trim() === SUIVI_SUSPENSION_HEADER ||
        String(row2[c] || '').trim() === SUIVI_SUSPENSION_HEADER) {
      return c + 1;
    }
  }
  return null;
}

// "Sélection"/"Dans la liste" columns and "Selections fixtures" tab (see
// doGet's ?matchsSelection= docs above). SELECTION_COL/DANS_LA_LISTE_COL
// are hardcoded (confirmed live via a one-off header search, same way
// SUIVI_SUSPENSION_HEADER's column was found) rather than looked up by
// header text each request like findSuiviSuspensionColumn_ does -- these
// two are read on every ?matchsSelection= request instead of once per
// backfill run, so a live header-text scan on every request would add a
// second full-header-row read to an already-uncached-on-miss endpoint for
// no real benefit; re-check the header row by hand if these ever shift.
var SELECTION_COL = 145;
var DANS_LA_LISTE_COL = 146;
var SHEET_NAME_SELECTIONS_FIXTURES = 'Selections fixtures';

// "Sélection"'s values (French, e.g. "Côte d'Ivoire Espoir" -- confirmed
// live 2026-09-21 that what's actually typed there doesn't consistently
// match the "Sélection" reference tab's own PAYS dropdown spelling/casing,
// e.g. "Congo Brazzaville" instead of that tab's "REP CONGO B") and
// "Selections fixtures"'s Country values (English, e.g. "Côte d’Ivoire —
// espoir") use two entirely different vocabularies for the same countries
// -- this maps PAYS' BASE country name (suffix stripped) to the English
// name "Selections fixtures" actually uses. Matched case/accent-
// insensitively at lookup time, not as literal keys here -- see
// normalizedCountryLookup_/englishCountryForSelection_ below, which also
// layers in the handful of aliases the live sheet uses instead of the
// PAYS tab's own spelling. Covers every country in the "Sélection" tab's
// own PAYS list (confirmed 2026-09-21), not just ones currently assigned
// to a player, so a newly-assigned country doesn't silently fail the join
// later.
var PAYS_TO_ENGLISH_COUNTRY_ = {
  'AFRIQUE DU SUD': 'South Africa', 'ALBANIE': 'Albania', 'ALGERIE': 'Algeria',
  'ALLEMAGNE': 'Germany', 'ANDORRE': 'Andorra', 'ANGLETERRE': 'England',
  'ANGOLA': 'Angola', 'ARABIE SAOUDITE': 'Saudi Arabia', 'ARGENTINE': 'Argentina',
  'ARMENIE': 'Armenia', 'AUSTRALIE': 'Australia', 'AUTRICHE': 'Austria',
  'AZERBAIDJAN': 'Azerbaijan', 'BARHEIN': 'Bahrain', 'BELGIQUE': 'Belgium',
  'BENIN': 'Benin', 'BIELORUSSIE': 'Belarus', 'BOLIVIE': 'Bolivia',
  'BOSNIE': 'Bosnia and Herzegovina', 'BOTSWANA': 'Botswana', 'BRESIL': 'Brazil',
  'BULGARIE': 'Bulgaria', 'BURKINA FASO': 'Burkina Faso', 'BURKINA FASSO': 'Burkina Faso',
  'BURUNDI': 'Burundi', 'CAMEROUN': 'Cameroon', 'CANADA': 'Canada',
  'CAP-VERT': 'Cape Verde', 'CENTRAFRIQUE': 'Central African Republic', 'CHILI': 'Chile',
  'CHINE': 'China', 'CHYPRE': 'Cyprus', 'COLOMBIE': 'Colombia',
  'COMORES': 'Comoros', 'CONGO RDC': 'DR Congo', 'COREE DU SUD': 'South Korea',
  'COSTA RICA': 'Costa Rica', 'COTE D\'IVOIRE': 'Côte d’Ivoire', 'CROATIE': 'Croatia',
  'CUBA': 'Cuba', 'CURACAO': 'Curaçao', 'DANEMARK': 'Denmark',
  'DJIBOUTI': 'Djibouti', 'EAU U23': 'United Arab Emirates', 'ECOSSE': 'Scotland',
  'EGYPTE': 'Egypt', 'EMIRATS ARABES UNIS': 'United Arab Emirates', 'EQUATEUR': 'Ecuador',
  'ERYTHREE': 'Eritrea', 'ESPAGNE': 'Spain', 'ESTONIE': 'Estonia',
  'ETHIOPIE': 'Ethiopia', 'FINLANDE': 'Finland', 'FRANCE': 'France',
  'GABON': 'Gabon', 'GAMBIE': 'Gambia', 'GEORGIE': 'Georgia',
  'GHANA': 'Ghana', 'GIBRALTAR': 'Gibraltar', 'GRECE': 'Greece',
  'GUADELOUPE': 'Guadeloupe', 'GUATEMALA': 'Guatemala', 'GUINEE BISSAU': 'Guinea-Bissau',
  'GUINEE CONAKRY': 'Guinea', 'GUINEE EQUATO': 'Equatorial Guinea', 'GUYANE': 'Guyana',
  'HAÏTI': 'Haiti', 'HONDURAS': 'Honduras', 'HONG KONG': 'Hong Kong',
  'HONGRIE': 'Hungary', 'ILES FEROE': 'Faroe Islands', 'INDE': 'India',
  'INDONESIE': 'Indonesia', 'IRAN': 'Iran', 'IRAQ': 'Iraq',
  'IRLANCE': 'Republic of Ireland', 'IRLANDE': 'Republic of Ireland', 'IRLANDE DU NORD': 'Northern Ireland',
  'ISLANDE': 'Iceland', 'ISRAEL': 'Israel', 'ITALIE': 'Italy',
  'JAMAIQUE': 'Jamaica', 'JAPON': 'Japan', 'JORDANIE': 'Jordan',
  'KAZAKHSTAN': 'Kazakhstan', 'KENYA': 'Kenya', 'KIRGHIZISTAN': 'Kyrgyzstan',
  'KOSOVO': 'Kosovo', 'KOWEIT': 'Kuwait', 'LESOTHO': 'Lesotho',
  'LETTONIE': 'Latvia', 'LIBAN': 'Lebanon', 'LIBERIA': 'Liberia',
  'LIECHTENSTEIN': 'Liechtenstein', 'LITUANIE': 'Lithuania', 'LUXEMBOURG': 'Luxembourg',
  'LYBIE': 'Libya', 'MACEDOINE DU NORD': 'North Macedonia', 'MADAGASCAR': 'Madagascar',
  'MALAISIE': 'Malaysia', 'MALAWI': 'Malawi', 'MALI': 'Mali',
  'MALTE': 'Malta', 'MAROC': 'Morocco', 'MARTINIQUE': 'Martinique',
  'MAURITANIE': 'Mauritania', 'MEXIQUE': 'Mexico', 'MOLDAVIE': 'Moldova',
  'MONTENEGRO': 'Montenegro', 'MOZAMBIQUE': 'Mozambique', 'MYANMAR': 'Myanmar',
  'NAMIBIE': 'Namibia', 'NICARAGUA': 'Nicaragua', 'NIGER': 'Niger',
  'NIGERIA': 'Nigeria', 'NORVEGE': 'Norway', 'NOUVELLE CALEDONIE': 'New Caledonia',
  'NOUVELLE ZELANDE': 'New Zealand', 'OMAN': 'Oman', 'OUGANDA': 'Uganda',
  'OUZBEKISTAN': 'Uzbekistan', 'PALESTINE': 'Palestine', 'PANAMA': 'Panama',
  'PARAGUAY': 'Paraguay', 'PAYS DE GALLES': 'Wales', 'PAYS-BAS': 'Netherlands',
  'PEROU': 'Peru', 'PHILIPPINES': 'Philippines', 'POLOGNE': 'Poland',
  'PORTUGAL': 'Portugal', 'QATAR': 'Qatar', 'REP CONGO B': 'Congo',
  'REP TCHEQUE': 'Czech Republic', 'ROUMANIE': 'Romania', 'RUSSIE': 'Russia',
  'RWANDA': 'Rwanda', 'SAINT-MARIN': 'San Marino', 'SALVADOR': 'El Salvador',
  'SAO TOME': 'Sao Tome and Principe', 'SENEGAL': 'Senegal', 'SERBIE': 'Serbia',
  'SIERRA LEONE': 'Sierra Leone', 'SINGAPOUR': 'Singapore', 'SLOVAQUIE': 'Slovakia',
  'SLOVENIE': 'Slovenia', 'SOMALIE': 'Somalia', 'SOUDAN SUD': 'South Sudan',
  'SUEDE': 'Sweden', 'SUISSE': 'Switzerland', 'SURINAM': 'Suriname',
  'SYRIE': 'Syria', 'TAJIKISTAN': 'Tajikistan', 'TANZANIE': 'Tanzania',
  'TCHAD': 'Chad', 'THAÏLANDE': 'Thailand', 'TOGO': 'Togo',
  'TUNISIE': 'Tunisia', 'TURQUIE': 'Turkey', 'UKRAINE': 'Ukraine',
  'URUGUAY': 'Uruguay', 'USA': 'United States', 'VENEZUELA': 'Venezuela',
  'VIETNAM': 'Vietnam', 'ZAMBIE': 'Zambia', 'ZIMBABWE': 'Zimbabwe'
};

// Matches any espoir/youth suffix seen in practice, case-insensitively --
// both the "Sélection" reference tab's own PAYS abbreviations (ESP/ESPOIR/
// U16-U21) AND what's actually typed in the live sheet (the full word
// "Espoir", confirmed live 2026-09-21 -- the two don't agree with each
// other) -- or the senior-only "A" suffix (e.g. "FRANCE A").
var SELECTION_SUFFIX_RE_ = /\s+(ESPOIR|ESP|U1[6-9]|U2[0-1]|A)$/i;

// Lazily-built accent/case-insensitive view of PAYS_TO_ENGLISH_COUNTRY_,
// plus a few aliases confirmed live in the "Sélection" column that don't
// match the "Sélection" reference tab's own PAYS spelling at all (e.g. the
// sheet maintainer writes "Congo Brazzaville" and "Etats-Unis" by hand,
// where the PAYS tab calls those "REP CONGO B" and "USA") -- see
// englishCountryForSelection_.
var PAYS_TO_ENGLISH_COUNTRY_NORMALIZED_ = null;

function normalizeCountryKey_(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .toUpperCase()
    .trim();
}

function normalizedCountryLookup_() {
  if (!PAYS_TO_ENGLISH_COUNTRY_NORMALIZED_) {
    var lookup = {};
    Object.keys(PAYS_TO_ENGLISH_COUNTRY_).forEach(function (k) {
      lookup[normalizeCountryKey_(k)] = PAYS_TO_ENGLISH_COUNTRY_[k];
    });
    lookup['CONGO BRAZZAVILLE'] = 'Congo';
    lookup['ETATS-UNIS'] = 'United States';
    lookup['TCHEQUIE'] = 'Czech Republic';
    PAYS_TO_ENGLISH_COUNTRY_NORMALIZED_ = lookup;
  }
  return PAYS_TO_ENGLISH_COUNTRY_NORMALIZED_;
}

/**
 * Converts a "Sélection" value (e.g. "Côte d'Ivoire Espoir", "France A",
 * "GABON" -- casing/accents vary in practice, see SELECTION_SUFFIX_RE_'s
 * comment) to the exact Country string "Selections fixtures" keys its
 * fixtures by (e.g. "Côte d’Ivoire — espoir", "France", "Gabon"). Returns
 * null if the base country isn't found even after normalizing (shouldn't
 * happen for any value actually seen in the sheet as of 2026-09-21, but
 * defensive against a typo or a genuinely new country) -- callers then
 * just show no fixtures for that player rather than erroring.
 *
 * "Selections fixtures" doesn't distinguish youth levels (no separate
 * U17/U20/Espoirs rows per country, just one "— espoir" bucket per
 * country) -- so ANY espoir-type suffix maps to that same bucket, not a
 * level-specific lookup.
 */
function englishCountryForSelection_(selection) {
  var sel = String(selection || '').trim();
  if (!sel) return null;
  var isEspoir = /\s+(ESPOIR|ESP|U1[6-9]|U2[0-1])$/i.test(sel);
  var base = sel.replace(SELECTION_SUFFIX_RE_, '').trim();
  var english = normalizedCountryLookup_()[normalizeCountryKey_(base)];
  if (!english) return null;
  return isEspoir ? english + ' — espoir' : english;
}

/**
 * { EnglishCountryName: [{ opponent, isHome, date }, ...] } from the
 * "Selections fixtures" tab -- one row per country, up to 4 opponent
 * columns, each a raw string like "Türkiye ✈️ — 25 Sep" (✈️ = away,
 * 🏠 = home, trailing "— DD Mon" added 2026-09-21), "—" (empty slot,
 * skipped), or the literal placeholder "No confirmed fixture found" for
 * an espoir team with nothing scheduled yet (also skipped -- not a real
 * fixture). isHome is null if a fixture has neither icon (unexpected, but
 * shown rather than dropped); date is null if the cell has no trailing
 * "— DD Mon" (older/incomplete rows). Returns {} if the tab's ever
 * renamed/missing rather than erroring the whole ?matchsSelection=
 * request over it.
 */
function readSelectionsFixtures_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME_SELECTIONS_FIXTURES);
  if (!sheet) return {};
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2) return {};

  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var byCountry = {};
  values.forEach(function (row) {
    var country = String(row[0] || '').trim();
    if (!country) return;
    var matchs = [];
    for (var c = 1; c < row.length; c++) {
      var raw = String(row[c] || '').trim();
      if (!raw || raw === '—' || raw === 'No confirmed fixture found') continue;
      // The date (if present) trails the icon as "— DD Mon", so the
      // icon is no longer reliably at the end of the string -- split it
      // off first (by the LAST em dash, since a plain opponent name
      // never contains one) before looking for the icon in what's left.
      // Getting this order backwards was the original bug: matching the
      // icon at end-of-string against "Türkiye ✈️ — 25 Sep" always
      // failed, so isHome came back null and the date text leaked into
      // `opponent` (confirmed live 2026-09-21).
      var dashIdx = raw.lastIndexOf('—');
      var frontPart = dashIdx === -1 ? raw : raw.slice(0, dashIdx).trim();
      var date = dashIdx === -1 ? null : raw.slice(dashIdx + 1).trim();
      // Icon: 🏠 (U+1F3E0, a surrogate pair) or ✈️ (U+2708 + U+FE0F
      // variation selector). The `u` flag is required for a character
      // class to treat 🏠 as one codepoint instead of two stray surrogate
      // halves -- without it this silently left mangled leftover
      // characters in `opponent` (confirmed live 2026-09-21).
      var isHome = /\u{1F3E0}\s*$/u.test(frontPart);
      var isAway = /\u{2708}\u{FE0F}?\s*$/u.test(frontPart);
      var opponent = frontPart.replace(/[\u{1F3E0}\u{2708}\u{FE0F}]/gu, '').trim();
      matchs.push({ opponent: opponent, isHome: isHome ? true : (isAway ? false : null), date: date });
    }
    byCountry[country] = matchs;
  });
  return byCountry;
}

/**
 * Players with "Dans la liste" checked, grouped by club (equipe), each
 * with their raw "Sélection" PAYS string and that selection's matchs for
 * the current international break -- see doGet's ?matchsSelection= docs
 * above. `countries` is every distinct Sélection value actually present
 * among included players (sorted), for the frontend's country filter.
 */
function readPlayersInSelection_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  var lastRow = sheet.getLastRow();
  var numRows = lastRow - FIRST_DATA_ROW + 1;
  if (numRows <= 0) return { equipes: [], countries: [] };

  var identity = sheet.getRange(FIRST_DATA_ROW, 1, numRows, COL_POSTE_FIN).getValues();
  var selectionVals = sheet.getRange(FIRST_DATA_ROW, SELECTION_COL, numRows, 1).getValues();
  var dansListe = sheet.getRange(FIRST_DATA_ROW, DANS_LA_LISTE_COL, numRows, 1).getValues();
  var fixturesByCountry = readSelectionsFixtures_();

  var byTeam = {};
  var countriesSeen = {};
  for (var i = 0; i < numRows; i++) {
    if (dansListe[i][0] !== true) continue;

    var nom = identity[i][COL_NOM - 1];
    var equipe = identity[i][COL_EQUIPE - 1];
    if (!nom || !equipe) continue; // skip malformed/incomplete rows

    var sel = String(selectionVals[i][0] || '').trim();
    if (!sel) continue; // "Dans la liste" but no Sélection yet -- nothing to show

    var englishCountry = englishCountryForSelection_(sel);
    var matchs = englishCountry ? (fixturesByCountry[englishCountry] || []) : [];

    var player = {
      nom: nom,
      prenom: identity[i][COL_PRENOM - 1],
      posteFin: identity[i][COL_POSTE_FIN - 1],
      selection: sel,
      matchs: matchs
    };

    if (!byTeam[equipe]) byTeam[equipe] = [];
    byTeam[equipe].push(player);
    countriesSeen[sel] = true;
  }

  var equipes = Object.keys(byTeam).sort().map(function (equipe) {
    return { equipe: equipe, joueurs: byTeam[equipe] };
  });
  return { equipes: equipes, countries: Object.keys(countriesSeen).sort() };
}


/**
 * Reads the "Mise à jour" tab's A2:B19 status block (see STATUS_*
 * constants above) into a { equipe: statut } map. Rows with a blank club
 * or blank status are skipped rather than surfaced as an empty note.
 */
function readClubStatuses_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME_STATUS);
  if (!sheet) return {};

  var numRows = STATUS_LAST_ROW - STATUS_FIRST_ROW + 1;
  var values = sheet.getRange(STATUS_FIRST_ROW, STATUS_COL_EQUIPE, numRows, 2).getValues();
  var byTeam = {};
  values.forEach(function (row) {
    var equipe = String(row[0] || '').trim();
    var statut = String(row[1] || '').trim();
    if (equipe && statut) byTeam[equipe] = statut;
  });
  return byTeam;
}

function classify_(text, bgColor) {
  // A trailing "?" (e.g. "Transfert ?") marks the same category as the
  // plain value, just less certain — strip it before matching.
  var normalized = String(text || '').replace(/\s*\?\s*$/, '').trim();
  if (normalized === 'Disponible' || normalized.toLowerCase() === 'dans le groupe') return 'disponible';
  if (normalized === 'HG') return 'hors_groupe';
  if (normalized === 'Transfert') return 'transfert';
  if (normalized === 'Susp' || sameColor_(bgColor, COLOR_SUSPENDED)) return 'suspendu';
  if (normalized === 'Personnel' || sameColor_(bgColor, COLOR_PERSONAL)) return 'personnel';
  if (sameColor_(bgColor, COLOR_INJURED)) return 'blessure';
  return 'incertain';
}

// Display order for readUnavailablePlayers_'s per-team player list: every
// "out" category (blessure/suspendu/personnel/hors_groupe/transfert) before
// incertain, and incertain before disponible. Ranks, not a fixed list of
// named categories, so any category classify_ doesn't return a case for
// above still sorts as "out" (rank 0) rather than needing its own entry.
function categorySortRank_(categorie) {
  if (categorie === 'incertain') return 1;
  if (categorie === 'disponible') return 2;
  return 0;
}

function sameColor_(a, b) {
  return (a || '').toLowerCase() === (b || '').toLowerCase();
}

function jsonResponse_(payload) {
  return jsonResponseRaw_(JSON.stringify(payload));
}

function jsonResponseRaw_(json) {
  return ContentService.createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * One-time calibration helper — not called by doGet. Select "debugColors"
 * in the Apps Script editor's function dropdown and click Run, then check
 * View > Executions for the logged output: each unavailable player's
 * reason text next to the cell's actual background color hex, for the
 * first journée found. Use this to fill in COLOR_INJURED / COLOR_PERSONAL /
 * COLOR_SUSPENDED above.
 */
function debugColors() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  var map = buildJourneeColumnMap_(sheet);
  var firstJournee = Object.keys(map)[0];
  var col = map[firstJournee].blessSusp;
  var range = sheet.getRange(FIRST_DATA_ROW, col, 40, 1);
  var texts = range.getValues();
  var colors = range.getBackgroundColors();
  Logger.log('Journée: ' + firstJournee);
  for (var i = 0; i < texts.length; i++) {
    if (texts[i][0]) {
      Logger.log(texts[i][0] + ' -> ' + colors[i][0]);
    }
  }
}

// --- Fixtures cache (opponent/home-away/kickoff per team) -----------------
//
// Canonical implementation: fc-shared/gs/ligue1-fixtures.gs — shared with
// compos's apps-script/Code.gs (copy-pasted, not runtime-imported; Apps
// Script has no cross-project import). Replaces the frontend's previous
// approach of fetching pronos's /current endpoint client-side, which could
// only ever show opponent/home-away for the live current gameweek — this
// fetches the whole season once, into a "Fixtures" tab, so doGet's fixture
// lookup (readFixturesForGameweek_) is a pure Sheet read, no external call
// on the request path, and works for every journée.
//
// Setup (once, in the Apps Script editor): run setupFixturesTrigger, then
// run refreshFixtures once by hand to populate the tab immediately rather
// than waiting for the first scheduled firing.

// jeu-des-pronos already tracks the current Ligue 1 gameweek (same API the
// frontend uses to default the journée picker) — reused here server-side
// too, as the anchor for the fixtures refresh window below.
var PRONOS_API_BASE = 'https://dmytkubjxwwwkroutvdu.supabase.co/functions/v1/api';
var PRONOS_L1_LEAGUE_ID = '27f27a15-02a9-448a-98d5-80998e2fa52e';

// ma-api.ligue1.fr backs ligue1.com's own results/match-sheet pages and is
// public — no auth/cookies needed. championshipId 1 = Ligue 1 for the
// current season as observed 2026-08; re-verify at the start of a season in
// case IDs get reassigned.
var LIGUE1_API_BASE = 'https://ma-api.ligue1.fr';
var LIGUE1_CHAMPIONSHIP_ID = 1;

// ma-api.ligue1.fr's clubIdentity.name (full official name) -> this
// project's short Équipe convention (must match TEAM_LOGOS keys in
// frontend/index.html). Copied verbatim from compos's Code.gs, which built
// it the same way TEAM_LOGOS was, by inspecting real gameweek-1 API
// responses; update by hand if a club enters/leaves the league or the API
// renames a club.
var API_TEAM_NAME_MAP = {
  'Olympique de Marseille': 'Marseille',
  'RC Strasbourg Alsace': 'Strasbourg',
  'RC Lens': 'Lens',
  'AJ Auxerre': 'Auxerre',
  'Le Mans FC': 'Le Mans',
  'Stade Brestois 29': 'Brest',
  'OGC Nice': 'Nice',
  'FC Lorient': 'Lorient',
  'Toulouse FC': 'Toulouse',
  'Olympique Lyonnais': 'Lyon',
  'Estac Troyes': 'Troyes',
  'Paris FC': 'Paris FC',
  'Angers SCO': 'Angers',
  'LOSC Lille': 'Lille',
  'Havre Athletic Club': 'Le Havre',
  'AS Monaco': 'Monaco',
  'Stade Rennais FC': 'Rennes',
  'Paris Saint-Germain': 'Paris SG'
};

function mapApiTeamName_(apiName) {
  if (!apiName) return null;
  // Falls back to the raw API name if unmapped (new/renamed club) rather
  // than dropping the row — a mismatch is easy to spot and fix by hand.
  return API_TEAM_NAME_MAP[apiName] || apiName;
}

function fetchGameweekMatches_(gameweekNumber) {
  var url = LIGUE1_API_BASE + '/championship-matches/championship/' + LIGUE1_CHAMPIONSHIP_ID +
    '/game-week/' + gameweekNumber;
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return [];
  var data = JSON.parse(resp.getContentText());
  return Array.isArray(data) ? data : (data.matches || []);
}

// "Journée 12" -> 12, "12" -> 12, "J12" -> 12. NaN if no digits at all —
// callers fall back to exact string comparison in that case.
function gameweekNumberFromJournee_(journee) {
  var m = String(journee || '').match(/\d+/);
  return m ? parseInt(m[0], 10) : NaN;
}

/**
 * The live current Ligue 1 gameweek number, server-side — same
 * jeu-des-pronos endpoint the frontend already uses to default its journée
 * picker. Returns null on any failure; callers must treat that as
 * "unknown", not "gameweek 0".
 */
function fetchCurrentGameweekNumber_() {
  var url = PRONOS_API_BASE + '/v1/leagues/' + PRONOS_L1_LEAGUE_ID + '/current';
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return null;
  var data = JSON.parse(resp.getContentText());
  return data && data.gameweek ? data.gameweek.number : null;
}

// Maps a gameweek NUMBER (as tracked internally by refreshFixtures, in
// terms of ligue1.com's numeric gameweeks) to the exact journée STRING as
// it appears in the main sheet's row-1 headers -- confirmed directly
// against a live ?meta=1 request to be the bare "Journée N" form here,
// same as what buildFixtureRowsForGameweek_ already writes, but this still
// looks it up against the real sheet (via allKnownJournees_) rather than
// hardcoding 'Journée ' + gameweekNumber, in case that ever drifts (the
// two didn't match on the sibling compos project). Returns null if no such
// journée column exists yet.
function journeeLabelForGameweek_(gameweekNumber) {
  var match = null;
  allKnownJournees_().forEach(function (j) {
    if (gameweekNumberFromJournee_(j) === gameweekNumber) match = j;
  });
  return match;
}

var SEASON_GAMEWEEKS = 34;
var SHEET_NAME_FIXTURES = 'Fixtures';
// How many gameweeks past "current" to re-fetch on every trigger run, so a
// reschedule announced a few weeks out still gets picked up. Once a
// gameweek is cached and outside this window it's never refetched — a
// played match's fixture info doesn't change.
var FIXTURES_REFRESH_LOOKAHEAD = 3;

function getOrCreateFixturesSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(SHEET_NAME_FIXTURES);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME_FIXTURES);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 5).setValues([['Journée', 'Équipe', 'Adversaire', 'Domicile', 'CoupEnvoi']]);
  }
  return sheet;
}

/**
 * All cached fixture rows, grouped by extracted gameweek number — this tab
 * is always machine-written as "Journée N", but matching by number keeps
 * it consistent with how the rest of this file's doGet already tolerates
 * journée-string variants (see gameweekNumberFromJournee_).
 *
 * CoupEnvoi is stored and read back as a real Sheets Date value, not text
 * — deliberately leaning on Sheets' native datetime handling here.
 */
function readAllFixtureRows_(sheet) {
  var lastRow = sheet.getLastRow();
  var byGw = {};
  if (lastRow < 2) return byGw;
  var values = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  values.forEach(function (row) {
    var journee = String(row[0] || '').trim();
    var equipe = String(row[1] || '').trim();
    if (!journee || !equipe) return;
    var gw = gameweekNumberFromJournee_(journee);
    if (isNaN(gw)) return;
    var kickoff = row[4];
    if (!(kickoff instanceof Date) || isNaN(kickoff.getTime())) return;
    if (!byGw[gw]) byGw[gw] = [];
    byGw[gw].push({
      journee: journee,
      equipe: equipe,
      opponent: String(row[2] || '').trim(),
      isHome: row[3] === true,
      kickoff: kickoff
    });
  });
  return byGw;
}

/**
 * Pure Sheet read — no external call. Returns
 * { equipe: { opponent, isHome, kickoff } } for this gameweek, {} if
 * nothing has been cached for it yet (e.g. the trigger hasn't reached a
 * far-future gameweek, or ligue1.fr hasn't published it yet).
 */
function readFixturesForGameweek_(gameweekNumber) {
  var rows = readAllFixtureRows_(getOrCreateFixturesSheet_())[gameweekNumber] || [];
  var byEquipe = {};
  rows.forEach(function (r) {
    byEquipe[r.equipe] = { opponent: r.opponent, isHome: r.isHome, kickoff: r.kickoff.toISOString() };
  });
  return byEquipe;
}

/**
 * Builds one gameweek's fixture rows from ma-api.ligue1.fr's match-week
 * list. Returns [] (never a partial result) on any failure, so a transient
 * API hiccup can't overwrite already-cached good data — see
 * refreshFixtures's "only replace when non-empty" rule.
 */
function buildFixtureRowsForGameweek_(gameweekNumber) {
  var journee = 'Journée ' + gameweekNumber;
  var rows = [];
  try {
    fetchGameweekMatches_(gameweekNumber).forEach(function (m) {
      if (!m.home || !m.away || !m.date) return;
      var home = mapApiTeamName_(m.home.clubIdentity && m.home.clubIdentity.name);
      var away = mapApiTeamName_(m.away.clubIdentity && m.away.clubIdentity.name);
      if (!home || !away) return;
      var kickoff = new Date(m.date);
      if (isNaN(kickoff.getTime())) return;
      rows.push({ journee: journee, equipe: home, opponent: away, isHome: true, kickoff: kickoff });
      rows.push({ journee: journee, equipe: away, opponent: home, isHome: false, kickoff: kickoff });
    });
  } catch (err) {
    return [];
  }
  return rows;
}

/**
 * Trigger body. Refetches and rewrites (a) any gameweek with zero cached
 * rows yet — the first run after setup backfills the whole season this
 * way, ~34 UrlFetchApp calls, comfortably under Apps Script's 6-minute
 * trigger execution limit — and (b) every gameweek within
 * [currentGameweek, currentGameweek + FIXTURES_REFRESH_LOOKAHEAD], to
 * absorb broadcast-driven kickoff reschedules for upcoming matches.
 * Everything else already cached is left untouched. Rewrites the whole
 * tab's data rows in one batched write if anything changed, then bumps
 * the doGet response cache version so the next request sees fresh data
 * immediately instead of waiting out the 6h TTL.
 */
function refreshFixtures() {
  var sheet = getOrCreateFixturesSheet_();
  var byGw = readAllFixtureRows_(sheet);
  var current = fetchCurrentGameweekNumber_();
  var changed = false;
  var changedGameweeks = [];

  for (var gw = 1; gw <= SEASON_GAMEWEEKS; gw++) {
    var inWindow = current != null && gw >= current && gw <= current + FIXTURES_REFRESH_LOOKAHEAD;
    var missing = !byGw[gw] || byGw[gw].length === 0;
    if (!missing && !inWindow) continue;

    var fresh = buildFixtureRowsForGameweek_(gw);
    if (fresh.length) {
      byGw[gw] = fresh;
      changed = true;
      changedGameweeks.push(gw);
    }
  }

  if (!changed) return;

  var allRows = [];
  for (var g = 1; g <= SEASON_GAMEWEEKS; g++) {
    (byGw[g] || []).forEach(function (r) { allRows.push(r); });
  }

  var lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, 5).clearContent();
  if (allRows.length) {
    var values = allRows.map(function (r) { return [r.journee, r.equipe, r.opponent, r.isHome, r.kickoff]; });
    sheet.getRange(2, 1, values.length, 5).setValues(values);
  }

  // appendRow-style writes here are script-driven, so onEdit's simple
  // trigger won't fire for them -- bump the cache ourselves so a refreshed
  // fixture shows up on the next request instead of waiting out the
  // existing 6h TTL.
  PropertiesService.getScriptProperties().setProperty('cacheVersion', String(Date.now()));

  // Fixture data (opponent/home-away/kickoff) is embedded per-team in that
  // team's journée payload (see doGet), so a fixture change for gameweek N
  // invalidates exactly that journée's Worker/KV entry too -- same
  // per-journée granularity as doGet's own cache key. See
  // journeeLabelForGameweek_ for why this isn't simply 'Journée ' + gw.
  var changedJournees = changedGameweeks
    .map(journeeLabelForGameweek_)
    .filter(function (j) { return j; });
  notifyCacheWebhook_(changedJournees);
}

/**
 * One-time setup: run this once from the Apps Script editor to install the
 * 6h trigger. Re-running is safe — clears any trigger it previously
 * installed for refreshFixtures first, so triggers never stack up. Run
 * refreshFixtures once by hand afterward to populate the Fixtures tab
 * immediately instead of waiting for the first scheduled firing.
 */
function setupFixturesTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'refreshFixtures') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshFixtures').timeBased().everyHours(6).create();
}
