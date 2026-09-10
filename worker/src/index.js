/**
 * dnp-l1-cache — Cloudflare Worker edge cache in front of the Apps Script
 * JSON API backing l1.dnp.fantasy-coach.fr (apps-script/Code.gs).
 *
 * Routes:
 *   GET  /?journee=<name>   -> cached (or live-fetched+cached) journée payload
 *   GET  /?meta=1  or  /    -> cached (or live-fetched+cached) meta (journée list)
 *   POST /__revalidate      -> webhook, called from Code.gs on data changes:
 *                              re-fetches and overwrites KV for specific
 *                              journée(s) (always + "meta"). Requires the
 *                              X-Revalidate-Secret header.
 *   GET|POST /__warm-all    -> one-off admin command: populate KV for every
 *                              journée currently in ?meta=1. Same secret,
 *                              accepted as a header OR a ?secret= query
 *                              param so it's easy to curl by hand.
 *
 * KV key scheme deliberately mirrors Code.gs's own doGet cache-key logic
 * exactly (`cacheKey = journee ? 'journee:'+journee : 'meta'`), so a
 * revalidate call for "Journée 12" overwrites precisely the key a real
 * ?journee=Journée 12 request reads -- never a blanket flush. Confirmed
 * directly against a live request that this Sheet's journée labels really
 * are the bare "Journée N" form (unlike compos's sibling project, whose
 * internal-vs-displayed journée strings differ) -- see Code.gs's
 * journeeLabelForGameweek_ for where that would matter here too.
 */

const CORS_HEADERS = {
  // Public, read-only, non-sensitive data with no cookies/credentials, and
  // the frontend's own ?api= override (see frontend/index.html) is meant to
  // let a developer point at arbitrary hosts for local/dev testing -- a
  // strict origin allowlist would break that override for no real security
  // benefit here. If this ever needs tightening, swap for a fixed
  // 'https://l1.dnp.fantasy-coach.fr'.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Revalidate-Secret',
  'Access-Control-Max-Age': '86400',
};

export default {
  /**
   * @param {Request} request
   * @param {{CACHE: KVNamespace, APPS_SCRIPT_BASE: string, REVALIDATE_SECRET: string}} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      if (url.pathname === '/__revalidate' && request.method === 'POST') {
        return await handleRevalidate(request, env, ctx);
      }
      if (url.pathname === '/__warm-all') {
        return await handleWarmAll(request, env);
      }
      if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
        return await handleCachedProxy(url, env);
      }
      return jsonResponse({ error: 'not found' }, 404);
    } catch (err) {
      return jsonResponse({ error: String((err && err.message) || err) }, 500);
    }
  },
};

function cacheKeyForJournee(journee) {
  return journee ? 'journee:' + journee : 'meta';
}

function originUrlFor(env, journee) {
  return journee
    ? env.APPS_SCRIPT_BASE + '?journee=' + encodeURIComponent(journee)
    : env.APPS_SCRIPT_BASE + '?meta=1';
}

async function handleCachedProxy(url, env) {
  const journee = url.searchParams.get('journee');
  const key = cacheKeyForJournee(journee);

  const cached = await env.CACHE.get(key);
  if (cached !== null) {
    return jsonPayload(cached, { 'X-Cache': 'HIT' });
  }

  const json = await fetchOriginJsonWithRetry(originUrlFor(env, journee), 3, 2000, 30000);
  await env.CACHE.put(key, json);
  return jsonPayload(json, { 'X-Cache': 'MISS' });
}

// Mirrors frontend/index.html's fetchJson_ retry/backoff shape (see its own
// comment about Apps Script's 10-40s cold-start window) -- this Worker is
// now the only thing that regularly has to absorb that latency; ordinary
// visitors should almost never hit this path once webhook-driven
// revalidation (see handleRevalidate) has pre-warmed the common journées.
//
// timeoutMs is a parameter (not always 30000) because this function serves
// two call sites with very different time budgets: handleCachedProxy is a
// normal request/response with no hard ceiling, but handleRevalidate's
// re-fetch runs inside ctx.waitUntil, which Cloudflare hard-caps at 30s
// TOTAL for a request (shared across every waitUntil call for that
// invocation, cancelled without completing if exceeded -- see
// revalidateAll for how that's budgeted for).
async function fetchOriginJsonWithRetry(url, attemptsLeft, delayMs, timeoutMs) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) throw new Error('origin responded ' + resp.status);
    const text = await resp.text();
    JSON.parse(text); // Apps Script cold-starts/errors can return an HTML
                       // page with a 200 status -- validate before trusting
                       // or caching it.
    return text;
  } catch (err) {
    if (attemptsLeft <= 1) throw err;
    await sleep(delayMs);
    return fetchOriginJsonWithRetry(url, attemptsLeft - 1, delayMs * 2, timeoutMs);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleRevalidate(request, env, ctx) {
  if (!validSecret(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: 'invalid JSON body' }, 400);
  }

  const journees = Array.isArray(body.journees) ? body.journees
    : (body.journee ? [body.journee] : []);
  // meta is always included -- a journée-level change can mean a brand new
  // row (new journée) in the sheet, which changes the meta list too.
  const targets = Array.from(new Set([null, ...journees]));

  // Respond immediately so the caller -- Code.gs's onEdit, via
  // UrlFetchApp.fetch, which runs inside Google's execution-time budget for
  // simple triggers -- is never blocked on how long Apps Script itself
  // takes to answer the re-fetch below. The actual re-fetch+KV overwrite
  // continues in the background via ctx.waitUntil.
  ctx.waitUntil(revalidateAll(targets, env));
  return jsonResponse({ ok: true, queued: targets.map(cacheKeyForJournee) });
}

async function revalidateAll(journees, env) {
  // Parallel, single attempt, no retry/backoff -- ctx.waitUntil (see
  // handleRevalidate) has a hard 30s ceiling for the WHOLE invocation
  // (confirmed against Cloudflare's docs; exceeding it cancels whatever
  // hasn't settled yet, with no error surfaced to the caller). A single
  // 25s-per-target attempt, raced together via Promise.all instead of
  // looped, keeps the common case (an edit's own journée + "meta", i.e. 2
  // targets) comfortably inside the 30s ceiling even against a cold Apps
  // Script, and gives the rare all-journées fallback (34 journées, see
  // targetedJourneesFromEdit_ in Code.gs) its best realistic shot -- some
  // may still miss the window, which is an accepted, self-correcting
  // degradation (see the catch below), not a failure worth engineering
  // further for.
  await Promise.all(journees.map(async (journee) => {
    try {
      const json = await fetchOriginJsonWithRetry(originUrlFor(env, journee), 1, 0, 25000);
      await env.CACHE.put(cacheKeyForJournee(journee), json);
    } catch (err) {
      // Best-effort: a failed revalidation just leaves whatever was
      // previously in KV in place (stale, not missing) -- the next real
      // visitor still gets a fast, if outdated, response instead of an
      // error, and the next successful edit's revalidation call corrects it.
      console.error('revalidate failed for', journee, err);
    }
  }));
}

async function handleWarmAll(request, env) {
  if (!validSecret(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);

  const metaJson = await fetchOriginJsonWithRetry(originUrlFor(env, null), 3, 2000, 30000);
  await env.CACHE.put('meta', metaJson);
  const journees = JSON.parse(metaJson);

  const results = [];
  // Small batches, not all 34 at once -- stays well clear of Apps Script's
  // per-account concurrent-execution ceiling for anonymous web-app requests.
  // No ctx.waitUntil/30s-ceiling concern here (unlike revalidateAll) -- this
  // handler is awaited directly by the curl/caller, so it can take as long
  // as it needs.
  const BATCH_SIZE = 4;
  for (let i = 0; i < journees.length; i += BATCH_SIZE) {
    const batch = journees.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(async (journee) => {
      try {
        const json = await fetchOriginJsonWithRetry(originUrlFor(env, journee), 3, 2000, 30000);
        await env.CACHE.put(cacheKeyForJournee(journee), json);
        return { journee, ok: true };
      } catch (err) {
        return { journee, ok: false, error: String((err && err.message) || err) };
      }
    }));
    results.push(...batchResults);
  }

  return jsonResponse({ ok: true, meta: journees.length, results });
}

function validSecret(request, env) {
  const url = new URL(request.url);
  const provided = request.headers.get('X-Revalidate-Secret') || url.searchParams.get('secret');
  return Boolean(env.REVALIDATE_SECRET) && provided === env.REVALIDATE_SECRET;
}

function jsonResponse(obj, status) {
  return jsonPayload(JSON.stringify(obj), {}, status);
}

function jsonPayload(text, extraHeaders, status) {
  return new Response(text, {
    status: status || 200,
    headers: Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8' },
      CORS_HEADERS,
      extraHeaders || {}
    ),
  });
}
