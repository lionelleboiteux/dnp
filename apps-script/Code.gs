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

// CacheService's own cap; also used as a safety-net TTL in case an edit
// somehow doesn't trigger onEdit below.
var CACHE_TTL_SECONDS = 21600;

// Bump whenever doGet's *response shape* changes (a field added/removed/
// renamed) -- distinct from cacheVersion (which tracks *data* changes via
// onEdit/refreshFixtures). A code deploy alone doesn't touch cacheVersion,
// so a journée whose cache entry happened to still be warm from before the
// deploy would otherwise keep serving the old shape for up to
// CACHE_TTL_SECONDS regardless of any code change (observed directly on
// the sibling compos project when adding a `lastUpdated` field left one
// still-warm journée serving a response with no `lastUpdated` at all, while
// others had already expired/recomputed). Bumping this forces every entry
// to recompute on the next request after a shape change, independent of
// edits.
var CACHE_SCHEMA_VERSION = 2;

function doGet(e) {
  var journee = e.parameter.journee;
  var cacheKey = journee ? 'journee:' + journee : 'meta';

  var cached = cacheGet_(cacheKey);
  if (cached !== null) {
    return jsonResponseRaw_(cached);
  }

  var sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  var journeeMap = buildJourneeColumnMap_(sheet);

  var payload;
  if (!journee) {
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
 * without needing to know which keys currently exist.
 *
 * Deliberately does NOT also call notifyCacheWebhook_ here: simple triggers
 * (this function) are barred by the platform from calling any service that
 * requires authorization — UrlFetchApp included — even if the script
 * already has that scope (confirmed against Apps Script's own docs on
 * simple-trigger restrictions; a first attempt at calling the webhook
 * straight from here failed completely silently, since notifyCacheWebhook_
 * swallows the resulting exception). See onEditCacheWebhook_/
 * setupCacheWebhookTrigger below for the installable-trigger counterpart
 * that actually can make the call.
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
// so it can proactively re-fetch and re-cache -- both the "flush" and the
// "pre-load" of that edge cache -- rather than only lazily filling in on
// the next visitor's request.

/**
 * Installable-trigger counterpart to onEdit above — unlike a simple
 * trigger, this runs with full authorization and can call UrlFetchApp (via
 * notifyCacheWebhook_) to push the affected journée(s) to the Cloudflare
 * Worker cache (see worker/src/index.js), targeted via
 * targetedJourneesFromEdit_ when possible rather than a blanket
 * everything-changed signal. Registered by setupCacheWebhookTrigger below.
 */
function onEditCacheWebhook_(e) {
  var journees = targetedJourneesFromEdit_(e);
  notifyCacheWebhook_(journees === null ? allKnownJournees_() : journees);
}

/**
 * One-time setup: run this once from the Apps Script editor (select it in
 * the function dropdown, click Run, grant the requested permissions) to
 * install the installable onEdit trigger above. Re-running is safe — it
 * removes any trigger it previously installed for onEditCacheWebhook_
 * before adding a new one, so this never stacks up duplicate triggers.
 * Same pattern as setupFixturesTrigger further down this file.
 */
function setupCacheWebhookTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onEditCacheWebhook_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onEditCacheWebhook_').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();
}

/**
 * POSTs to the Worker's /__revalidate endpoint with the journée(s) that
 * changed. CACHE_WEBHOOK_URL/CACHE_WEBHOOK_SECRET are Script Properties
 * (Project Settings > Script Properties in the editor — never committed
 * here, and clasp has no CLI for setting them). Silently no-ops if either
 * is unset, so this feature is safe to leave unconfigured. Wrapped in
 * try/catch so a Worker outage/timeout never surfaces as an error to
 * whoever is editing the sheet, or breaks the caller's own logic — worst
 * case is a stale edge cache entry until the next successful call.
 */
function notifyCacheWebhook_(journees) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('CACHE_WEBHOOK_URL');
  var secret = props.getProperty('CACHE_WEBHOOK_SECRET');
  if (!url || !secret || !journees || !journees.length) return;

  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Revalidate-Secret': secret },
      payload: JSON.stringify({ journees: journees }),
      muteHttpExceptions: true
    });
  } catch (err) {
    console.error('notifyCacheWebhook_ failed', err);
  }
}

// Safety-net list of every journée the Worker should revalidate when a
// targeted one can't be determined from the edit event -- built from the
// same source doGet's own ?meta=1 response uses (buildJourneeColumnMap_),
// so it never drifts from what's actually in the sheet.
function allKnownJournees_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  return Object.keys(buildJourneeColumnMap_(sheet));
}

/**
 * Returns the distinct journée column-group(s) (as row-1 label strings,
 * exactly matching doGet's cache-key/journeeMap keys) touched by this edit
 * event, if `e` is a real edit on the main sheet — handles multi-column
 * edits (e.g. pasting several journée groups at once fires ONE onEdit call,
 * not one per column) by scanning the whole edited column range, not just
 * its first column.
 *
 * An edit to any of the fixed identity columns (A..G, at or left of
 * COL_POSTE_FIN — nom/prenom/equipe/posteFin/retourPrevu) or to either
 * header row can't be targeted: that data is embedded in EVERY journée's
 * payload (see readUnavailablePlayers_), so this returns null there to mean
 * "can't narrow it down, revalidate everything" rather than a specific
 * list — same conservative fallback used for an edit on any other sheet
 * (e.g. "Fixtures", which is script-written anyway and never fires onEdit;
 * or the "Mise à jour" per-club status tab, whose text is likewise
 * embedded in every journée's payload — see readClubStatuses_/doGet).
 *
 * Returns [] (not null) when the edit is inside the main sheet's data area
 * but doesn't overlap any known journée's 3-column group (e.g. a stray
 * column past the last journée) — nothing needs revalidating.
 */
function targetedJourneesFromEdit_(e) {
  if (!e || !e.range) return null;
  var sheet = e.range.getSheet();
  if (!sheet || sheet.getName() !== SHEET_NAME) return null;
  if (e.range.getRow() <= 2) return null;
  if (e.range.getColumn() <= COL_POSTE_FIN) return null;

  var startCol = e.range.getColumn();
  var endCol = startCol + e.range.getNumColumns() - 1;

  var journeeMap = buildJourneeColumnMap_(sheet);
  var journees = [];
  Object.keys(journeeMap).forEach(function (label) {
    var cols = journeeMap[label];
    var groupStart = cols.mn - 1; // Carton column, the first of the group's 3
    var groupEnd = cols.blessSusp; // Bless/Susp column, the last of the group's 3
    if (endCol >= groupStart && startCol <= groupEnd) journees.push(label);
  });
  return journees;
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
    return { equipe: equipe, joueurs: byTeam[equipe] };
  });
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
// two didn't match on the sibling compos project — see
// targetedJourneesFromEdit_'s neighbourhood for the same lesson applied
// there). Returns null if no such journée column exists yet.
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
