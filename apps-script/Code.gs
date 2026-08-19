/**
 * DNP — L1 unavailable players API.
 *
 * Bound to the Google Sheet "Stats joueur L1 - Saison 25-26". Deployed as a
 * Web App (Deploy > New deployment > Web app), "Execute as: Me",
 * "Who has access: Anyone" — this lets an anonymous visitor's browser read
 * data derived from the sheet without the sheet itself being shared or
 * published. Only the fields returned below ever leave the sheet.
 *
 * Endpoints (all GET, no auth):
 *   ?meta=1            -> ["Journée 12", "Journée 11", ..., "Journée 1", "Journée 13", ...]
 *                         (next journée to be played first, then already-played
 *                         journées most-recent-first, then further-future ones)
 *   ?journee=Journée 12 -> [{ equipe, joueurs: [{nom, prenom, posteFin, raison, categorie}] }]
 */

// Confirmed against the live sheet (debugColors() for red, manual cell
// checks on Arcus/"Musculaire" and Mensah/"Paternité" for the other two).
var COLOR_INJURED = '#ff00ff';
var COLOR_PERSONAL = '#42ff40';
var COLOR_SUSPENDED = '#ff0000';

// TODO: confirm this is the tab at gid=1172236022 in the sheet URL.
var SHEET_NAME = 'Liste Joueur 25-26';

// Identity columns, 1-indexed, matching the sheet's fixed left-hand columns.
var COL_NOM = 2;
var COL_PRENOM = 3;
var COL_EQUIPE = 4;
var COL_POSTE_FIN = 6;

// Data rows start after the two header rows (main label row + Carton/MN/Bless-Susp sub-header row).
var FIRST_DATA_ROW = 3;

function doGet(e) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  var journeeMap = buildJourneeColumnMap_(sheet);

  var journee = e.parameter.journee;
  if (!journee) {
    return jsonResponse_(orderedJourneeList_(sheet, journeeMap));
  }

  var cols = journeeMap[journee];
  if (!cols) {
    return jsonResponse_({ error: 'Journée inconnue: ' + journee });
  }

  return jsonResponse_(readUnavailablePlayers_(sheet, cols));
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

/**
 * Object key order for buildJourneeColumnMap_'s map is insertion order,
 * i.e. chronological (left-to-right in the sheet). A journée counts as
 * "played" when its Bless/Susp column has at least one non-blank cell —
 * future journées are entirely blank there until that week's data is
 * entered (MN is filled in ahead of time and so isn't a reliable signal).
 * Played journées are assumed to form a contiguous prefix of the season
 * (weeks are filled in order), so this walks forward and stops at the
 * first gap.
 *
 * Returned order: next journée to be played first, then already-played
 * journées most-recent-first, then any further-future journées in their
 * normal order.
 */
function orderedJourneeList_(sheet, journeeMap) {
  var labels = Object.keys(journeeMap);
  if (labels.length === 0) return labels;

  var lastRow = sheet.getLastRow();
  var numRows = lastRow - FIRST_DATA_ROW + 1;
  if (numRows <= 0) return labels;

  var firstMnCol = journeeMap[labels[0]].mn;
  var lastBlessCol = journeeMap[labels[labels.length - 1]].blessSusp;
  var block = sheet.getRange(FIRST_DATA_ROW, firstMnCol, numRows, lastBlessCol - firstMnCol + 1).getValues();

  var lastPlayedIdx = -1;
  for (var li = 0; li < labels.length; li++) {
    var blessOffset = journeeMap[labels[li]].blessSusp - firstMnCol;
    var played = false;
    for (var r = 0; r < numRows; r++) {
      var v = String(block[r][blessOffset] || '').trim();
      if (v !== '') {
        played = true;
        break;
      }
    }
    if (played) lastPlayedIdx = li;
    else break;
  }

  var nextIdx = lastPlayedIdx + 1;
  if (nextIdx >= labels.length) {
    // Whole season already has data — just show most recent first.
    return labels.slice().reverse();
  }

  var upcoming = labels.slice(nextIdx); // [nextToPlay, ...further future]
  var playedDesc = labels.slice(0, nextIdx).reverse(); // most recently played first
  return [upcoming[0]].concat(playedDesc, upcoming.slice(1));
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
      categorie: classify_(text, colors[i][0])
    };

    if (!byTeam[equipe]) byTeam[equipe] = [];
    byTeam[equipe].push(player);
  }

  return Object.keys(byTeam).sort().map(function (equipe) {
    return { equipe: equipe, joueurs: byTeam[equipe] };
  });
}

function classify_(text, bgColor) {
  if (text === 'HG') return 'hors_groupe';
  if (text === 'Susp' || sameColor_(bgColor, COLOR_SUSPENDED)) return 'suspendu';
  if (sameColor_(bgColor, COLOR_INJURED)) return 'blessure';
  if (sameColor_(bgColor, COLOR_PERSONAL)) return 'personnel';
  return 'autre';
}

function sameColor_(a, b) {
  return (a || '').toLowerCase() === (b || '').toLowerCase();
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
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
