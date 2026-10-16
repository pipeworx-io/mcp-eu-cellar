interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Every document the Publications Office of the European Union publishes — legislation, treaties, case law and COM proposals — searchable from the CELLAR repository.
 *
 * CELLAR is the Publications Office's semantic repository, queried here over
 * its public SPARQL endpoint.
 *
 * WHY THIS PACK EXISTS ALONGSIDE `eur-lex`
 * ----------------------------------------
 * `mcps/eur-lex` also talks to publications.europa.eu, but it is a CURATED
 * legal-compliance surface: a hand-kept index of ~14 named acts (GDPR, AI Act,
 * DORA...), article-level text extraction, and CJEU judgment lookup. Its SPARQL
 * use is hard-wired to legislation with an English expression.
 *
 * This pack is the repository itself. CELLAR holds every Work the Publications
 * Office issues — the Official Journal, treaties, consolidated texts,
 * preparatory acts, EFTA and case law — described in the Common Data Model
 * (CDM) ontology and indexed by EuroVoc. The three tools here are
 * general-purpose: an arbitrary (SELECT-only) SPARQL tool, a full-text Work
 * search across all resource types, and a metadata read for one Work by CELEX
 * or by CELLAR UUID. Use `eur-lex` when the question is "what does GDPR
 * Article 17 say"; use this when the question is "what has the EU published
 * about X", or when you need to ask the graph a question nobody wrote a tool
 * for.
 *
 * TRAPS, ALL VERIFIED LIVE 2026-09-17
 * -----------------------------------
 * 1. The endpoint is Virtuoso. A `FILTER(CONTAINS(...))` over ?title is a full
 *    scan of every expression in the repository and will time out. The
 *    full-text index is reached with `?title bif:contains "'phrase'"` — note
 *    the INNER single quotes, which Virtuoso requires for a multi-word phrase.
 *    `cellar_search_works` builds that form; a bare word list without the inner
 *    quotes silently matches far more than you meant.
 * 2. CELEX identifiers are typed literals, not plain strings. A triple pattern
 *    written `?w cdm:resource_legal_id_celex "32024R1689"` matches NOTHING —
 *    it must carry `^^xsd:string`. This is a 200-with-zero-rows failure, not an
 *    error, which is exactly the silent-zero class (docs/silent-zero-policy.md).
 * 3. Titles come back BOTH ways: some carry `xml:lang: "en"`, some are
 *    `xsd:string` with no language tag. Filtering on `lang(?title) = "en"`
 *    drops a large share of the repository. We filter on the EXPRESSION's
 *    language URI instead, which is the modelled fact.
 * 4. The same Work returns one row per (title, type, subject) combination, so
 *    a "single work" query legitimately returns 20 rows describing one thing.
 *    `cellar_work` collapses them; if you write your own SPARQL, expect the
 *    cross product.
 * 5. `format=application/sparql-results+json` must be passed as a QUERY
 *    PARAMETER. The `Accept` header alone is honoured inconsistently and you
 *    can get RDF/XML back where you asked for JSON.
 *
 * Keyless. No registration, no quota published.
 */


const SPARQL = 'https://publications.europa.eu/webapi/rdf/sparql';
const CELLAR_RESOURCE = 'http://publications.europa.eu/resource/cellar';
const EURLEX_DOC = 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:';

const UA = 'pipeworx-mcp-eu-cellar/1.0 (+https://pipeworx.io)';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, Accept: 'application/sparql-results+json', ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'EU Publications Office (CELLAR SPARQL)');
}

interface SparqlBinding {
  type: string;
  value: string;
  datatype?: string;
  'xml:lang'?: string;
}
interface SparqlResults {
  head: { vars: string[] };
  results: { bindings: Record<string, SparqlBinding>[] };
}

/** Time budget CELLAR itself enforces, in milliseconds, passed as `timeout`. */
const UPSTREAM_TIMEOUT_MS = 30_000;

async function runSparql(query: string): Promise<SparqlResults> {
  const url = new URL(SPARQL);
  url.searchParams.set('query', query);
  // Trap 5: the format parameter, not the Accept header, is what decides this.
  url.searchParams.set('format', 'application/sparql-results+json');
  url.searchParams.set('timeout', String(UPSTREAM_TIMEOUT_MS));

  const res = await pwFetch(url);
  const body = await res.text();
  if (!res.ok) {
    throw new Error(
      `CELLAR SPARQL returned HTTP ${res.status}. ${summarizeErrorBody(body)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Virtuoso answers a malformed query with an HTML or plain-text error page
    // under HTTP 200. Without this branch that arrives as "no results".
    throw new Error(
      `CELLAR SPARQL answered HTTP 200 with a non-JSON body — the query was rejected. Upstream said: ${summarizeErrorBody(body)}`,
    );
  }
  const r = parsed as SparqlResults;
  if (!r?.results?.bindings) {
    throw new Error(`CELLAR SPARQL returned an unexpected payload shape: ${summarizeErrorBody(body)}`);
  }
  return r;
}

function val(row: Record<string, SparqlBinding>, key: string): string | null {
  const b = row[key];
  return b && typeof b.value === 'string' ? b.value : null;
}

function cellarIdFromUri(uri: string | null): string | null {
  if (!uri) return null;
  const m = uri.match(/\/cellar\/([0-9a-f-]{8,})/i);
  return m ? m[1] : null;
}

function lastSegment(uri: string | null): string | null {
  if (!uri) return null;
  const parts = uri.split(/[/#]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/**
 * Escape a user phrase for Virtuoso's `bif:contains`. The operator takes a
 * mini query language of its own (AND / OR / NEAR, `*` truncation), so the
 * safe form for arbitrary caller text is a quoted phrase with the inner quotes
 * doubled. See trap 1.
 */
function bifPhrase(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** SPARQL string literal escaping (backslash, quote, newline). */
function sparqlString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '');
}

function clampLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

const RESOURCE_TYPE_HINTS: Record<string, string> = {
  REG: 'Regulation',
  DIR: 'Directive',
  DEC: 'Decision',
  RECO: 'Recommendation',
  OPIN: 'Opinion',
  JUDG: 'Judgment (Court of Justice)',
  ORD: 'Order (Court of Justice)',
  OPIN_JUR: 'Opinion of an Advocate General',
  TREATY: 'Treaty',
  OJ: 'Official Journal issue',
  COM: 'Commission communication / proposal (COM document)',
  CONS_TEXT: 'Consolidated text',
};

// ── national transposition measures (NIM) ──────────────────────────
//
// Verified live against the CELLAR SPARQL endpoint 2026-10-16, using
// Directive (EU) 2019/1937 (whistleblowers, CELEX 32019L1937) as the probe:
//   <nim work> cdm:measure_national_implementing_implements_resource_legal <directive work>
//   <nim work> cdm:measure_national_implementing_implemented_by_country <authority/country/XXX>
// plus cdm:work_title, cdm:work_date_document, cdm:measure_national_implementing_date_notification,
// cdm:measure_national_implementing_date_official_journal (sentinel "1001-01-01" = unknown — the
// CDM ontology's own placeholder, not a real Y1001 publication date; nulled out below),
// cdm:measure_national_implementing_name_official_journal / _number_official_journal /
// _type_act. None of this is documented outside the ontology itself — found by introspecting
// the live predicates of a known directive and a known NIM work, not from a spec.
//
// ORDERING (fixed 2026-10-16, fleet #3196): CELLAR carries no "this is the principal/main
// transposing act" flag anywhere in the NIM record — verified live by dumping every triple
// on several French and German NIM works for 32019L1937 (cdm:measure_national_implementing_type_act
// only ever held an act-form label like "Loi"/"Code"/"Gesetz"/"Verordnung", never a
// principal/additional marker). A member state can notify dozens of measures per directive —
// France has 36 for the Whistleblower Directive, Czechia 80, Croatia 93 — mixing the actual
// transposing act with decades-old codal provisions CELLAR also links as relevant. Sorting by
// document_date ascending (the old behaviour) surfaces whichever measure happens to be oldest,
// which for France was the Loi du 29 juillet 1881 (press law) — not useful. Measures are now
// ranked by (1) how many content words a measure's own title shares with the directive's own
// title, read in WHICHEVER of CELLAR's ~24 language variants scores highest (so a French loi's
// French title is compared against the directive's French title, a German Gesetz's title
// against the German one, with no per-country language table to maintain), then (2) newest
// document_date first. A national law that actually transposes a directive conventionally
// echoes the directive's own title in its own preamble/title, so this surfaces the real
// transposing act well ahead of tangential citations without needing a hand-kept list of
// "the one true measure" per directive. Verified live: FR/32019L1937 puts loi n° 2022-401 among
// the top entries (tied for rank 2-4 by document_date within the matched group); DE puts the
// Hinweisgeberschutzgesetz at rank ~6 of 17 (well inside the default limit_per_state=10, far
// ahead of its old rank 16/17); CZ puts "Zákon č. 171/2023 Sb., o ochraně oznamovatelů" at rank
// 1 of 80; HR puts "Zakon o zaštiti prijavitelja nepravilnosti" and its own amendments at ranks
// 1-3 of 93. This is a best-effort signal, not a guarantee — CELLAR itself does not say which
// measure is "the" one.

interface MemberState {
  iso3: string;
  iso2: string;
  name: string;
}

/** The 27 current EU member states (post-Brexit, post-Croatia-2013; no change since). Fixed —
 *  this is a closed, rarely-changing enumeration, not a corpus, so it is a literal here rather
 *  than a KV-baked index. */
const EU_MEMBER_STATES: MemberState[] = [
  { iso3: 'AUT', iso2: 'AT', name: 'Austria' },
  { iso3: 'BEL', iso2: 'BE', name: 'Belgium' },
  { iso3: 'BGR', iso2: 'BG', name: 'Bulgaria' },
  { iso3: 'HRV', iso2: 'HR', name: 'Croatia' },
  { iso3: 'CYP', iso2: 'CY', name: 'Cyprus' },
  { iso3: 'CZE', iso2: 'CZ', name: 'Czechia' },
  { iso3: 'DNK', iso2: 'DK', name: 'Denmark' },
  { iso3: 'EST', iso2: 'EE', name: 'Estonia' },
  { iso3: 'FIN', iso2: 'FI', name: 'Finland' },
  { iso3: 'FRA', iso2: 'FR', name: 'France' },
  { iso3: 'DEU', iso2: 'DE', name: 'Germany' },
  { iso3: 'GRC', iso2: 'GR', name: 'Greece' },
  { iso3: 'HUN', iso2: 'HU', name: 'Hungary' },
  { iso3: 'IRL', iso2: 'IE', name: 'Ireland' },
  { iso3: 'ITA', iso2: 'IT', name: 'Italy' },
  { iso3: 'LVA', iso2: 'LV', name: 'Latvia' },
  { iso3: 'LTU', iso2: 'LT', name: 'Lithuania' },
  { iso3: 'LUX', iso2: 'LU', name: 'Luxembourg' },
  { iso3: 'MLT', iso2: 'MT', name: 'Malta' },
  { iso3: 'NLD', iso2: 'NL', name: 'Netherlands' },
  { iso3: 'POL', iso2: 'PL', name: 'Poland' },
  { iso3: 'PRT', iso2: 'PT', name: 'Portugal' },
  { iso3: 'ROU', iso2: 'RO', name: 'Romania' },
  { iso3: 'SVK', iso2: 'SK', name: 'Slovakia' },
  { iso3: 'SVN', iso2: 'SI', name: 'Slovenia' },
  { iso3: 'ESP', iso2: 'ES', name: 'Spain' },
  { iso3: 'SWE', iso2: 'SE', name: 'Sweden' },
];
const EU_BY_ISO3 = new Map(EU_MEMBER_STATES.map((m) => [m.iso3, m]));

/** Live Pipeworx national-legislation packs that cover a member state, named here as the
 *  pack + tools an agent should call next — never a resolved document id, which CELLAR's NIM
 *  record does not carry (it gives the national gazette citation, not that pack's internal id). */
const NATIONAL_PACK_BY_ISO3: Record<string, { pack: string; search_tool: string; provision_tool: string; identifier: string }> = {
  DEU: { pack: 'de-gesetze', search_tool: 'gesetze_search', provision_tool: 'gesetze_provision', identifier: 'law abbreviation (e.g. "HinSchG") + provision number' },
  AUT: { pack: 'at-ris', search_tool: 'at_search_legislation', provision_tool: 'at_get_provision', identifier: 'Gesetzesnummer + paragraph' },
  ITA: { pack: 'it-normattiva', search_tool: 'it_normattiva_search', provision_tool: 'it_normattiva_get_article', identifier: 'URN' },
  NLD: { pack: 'nl-wetten', search_tool: 'nl_wetten_search', provision_tool: 'nl_wetten_get_article', identifier: 'BWB id' },
  FRA: { pack: 'france-legi', search_tool: 'fr_legi_search', provision_tool: 'fr_code_article', identifier: 'code + article number' },
  ESP: { pack: 'boe-legislacion', search_tool: 'boe_search_law', provision_tool: 'boe_law', identifier: 'BOE id' },
};

/** Common names for acts worth tracking transposition for, where the official EU title (what
 *  full-text search matches against) does not contain the colloquial name — "whistleblower"
 *  never appears in Directive (EU) 2019/1937's own title, verified live 2026-10-16. Small and
 *  hand-kept, like RESOURCE_TYPE_HINTS above; not a generated index. */
const DIRECTIVE_ALIASES: Record<string, string> = {
  'gdpr': '32016R0679',
  'general data protection regulation': '32016R0679',
  'whistleblower directive': '32019L1937',
  'whistleblowing directive': '32019L1937',
  'whistleblower protection directive': '32019L1937',
  'ai act': '32024R1689',
  'artificial intelligence act': '32024R1689',
  'nis2': '32022L2555',
  'nis2 directive': '32022L2555',
  'dsa': '32022R2065',
  'digital services act': '32022R2065',
  'dma': '32022R1925',
  'digital markets act': '32022R1925',
  'dora': '32022R2554',
  'digital operational resilience act': '32022R2554',
  'work-life balance directive': '32019L1158',
  'work life balance directive': '32019L1158',
  'pay transparency directive': '32023L0970',
  'platform work directive': '32024L2831',
  'working time directive': '32003L0088',
  'posted workers directive': '31996L0071',
  'late payment directive': '32011L0007',
  'unfair commercial practices directive': '32005L0029',
  'consumer rights directive': '32011L0083',
};

const CELEX_RE = /^\d{5}[A-Z]{1,2}\d{3,5}(\(\d+\))?$/i;
const NATURAL_NUMBER_RE = /^\(?(?:EU|EC|EEC)?\)?\s*(\d{4})\/(\d{1,5})$/i;

function countryIso3FromUri(uri: string | null): string | null {
  if (!uri) return null;
  const seg = lastSegment(uri);
  return seg ? seg.toUpperCase() : null;
}

/** Null out the CDM ontology's own placeholder date, not a real Y1001 record. */
function nullSentinelDate(d: string | null): string | null {
  if (!d) return null;
  return d.startsWith('1001-') ? null : d;
}

// ── subject-word ranking for national measures (see ORDERING note above) ──

/** A bare 4-digit year, e.g. "2019" — excluded from the word sets below: it coincidentally
 *  matches any unrelated national provision dated the same calendar year as the directive,
 *  without saying anything about subject. A combined form like "2019/1937" is specific enough
 *  to keep. */
const BARE_YEAR_RE = /^\d{4}$/;

/** Lowercased content words (letters/digits, >= 4 chars, unicode-aware so French/German/
 *  Croatian/Czech/Cyrillic text all tokenize) from a title, for subject-overlap scoring. */
function titleWords(title: string | null): Set<string> {
  if (!title) return new Set();
  const matches = title.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}]*(?:\/\d+)?/gu) ?? [];
  return new Set(matches.filter((w) => w.length >= 4 && !BARE_YEAR_RE.test(w)));
}

/** All titles CELLAR holds for one EU Work (every language it has an expression in), as word
 *  sets — one extra SPARQL call per transposition lookup, used to score how closely a national
 *  measure's own title echoes the directive's subject. See the ORDERING note above `MemberState`. */
async function fetchDirectiveTitleWordSets(workUri: string): Promise<Set<string>[]> {
  const sparql = `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT DISTINCT ?title WHERE {
  ?exp cdm:expression_belongs_to_work <${workUri}> ;
       cdm:expression_title ?title .
}
LIMIT 40`;
  const res = await runSparql(sparql);
  const sets: Set<string>[] = [];
  for (const row of res.results.bindings) {
    const w = titleWords(val(row, 'title'));
    if (w.size) sets.push(w);
  }
  return sets;
}

/** How many words a national measure's title shares with the directive's own title, taking
 *  whichever of CELLAR's language variants scores highest. Not a guarantee of relevance — a
 *  ranking signal, since CELLAR's NIM record carries no principal/main-measure flag. */
function subjectScore(title: string | null, directiveWordSets: Set<string>[]): number {
  const words = titleWords(title);
  if (!words.size || !directiveWordSets.length) return 0;
  let best = 0;
  for (const dset of directiveWordSets) {
    let n = 0;
    for (const w of words) if (dset.has(w)) n++;
    if (n > best) best = n;
  }
  return best;
}

interface ResolvedWork {
  work: string;
  celex: string | null;
  title: string | null;
  typeCode: string | null;
  documentDate: string | null;
}

async function resolveByCelex(celex: string): Promise<ResolvedWork[]> {
  const sparql = `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT DISTINCT ?work ?title ?type ?date WHERE {
  ?work cdm:resource_legal_id_celex "${sparqlString(celex)}"^^xsd:string .
  OPTIONAL { ?exp cdm:expression_belongs_to_work ?work ;
                  cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/ENG> ;
                  cdm:expression_title ?title }
  OPTIONAL { ?work cdm:work_has_resource-type ?type }
  OPTIONAL { ?work cdm:work_date_document ?date }
}
LIMIT 20`;
  const res = await runSparql(sparql);
  return res.results.bindings.map((row) => ({
    work: val(row, 'work') as string,
    celex,
    title: val(row, 'title'),
    typeCode: lastSegment(val(row, 'type')),
    documentDate: val(row, 'date'),
  }));
}

async function resolveByNaturalNumber(year: string, number: string): Promise<ResolvedWork[]> {
  const sparql = `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT DISTINCT ?work ?celex ?title ?type ?date WHERE {
  ?work cdm:resource_legal_number_natural "${sparqlString(number)}"^^xsd:positiveInteger ;
        cdm:resource_legal_year "${sparqlString(year)}"^^xsd:gYear .
  OPTIONAL { ?work cdm:resource_legal_id_celex ?celex }
  OPTIONAL { ?exp cdm:expression_belongs_to_work ?work ;
                  cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/ENG> ;
                  cdm:expression_title ?title }
  OPTIONAL { ?work cdm:work_has_resource-type ?type }
  OPTIONAL { ?work cdm:work_date_document ?date }
}
LIMIT 50`;
  const res = await runSparql(sparql);
  const out: ResolvedWork[] = [];
  const seen = new Set<string>();
  for (const row of res.results.bindings) {
    const celex = val(row, 'celex');
    const typeCode = lastSegment(val(row, 'type'));
    // Keep only base enactments: sector-3 CELEX, no corrigendum/consolidated suffix.
    if (!celex || !/^3\d{4}[A-Z]{1,2}\d{3,5}$/.test(celex)) continue;
    if (typeCode === 'CORRIGENDUM' || typeCode === 'CONS_TEXT') continue;
    const work = val(row, 'work') as string;
    if (seen.has(work)) continue;
    seen.add(work);
    out.push({ work, celex, title: val(row, 'title'), typeCode, documentDate: val(row, 'date') });
  }
  return out;
}

async function resolveByTitle(query: string, resourceType?: string): Promise<ResolvedWork[]> {
  const typeClause = resourceType
    ? `?work cdm:work_has_resource-type <http://publications.europa.eu/resource/authority/resource-type/${resourceType}> .`
    : '';
  const sparql = `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT DISTINCT ?work ?title ?celex ?type ?date WHERE {
  ?exp cdm:expression_belongs_to_work ?work ;
       cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/ENG> ;
       cdm:expression_title ?title .
  ?title bif:contains ${JSON.stringify(bifPhrase(query))} .
  ${typeClause}
  OPTIONAL { ?work cdm:resource_legal_id_celex ?celex }
  OPTIONAL { ?work cdm:work_has_resource-type ?type }
  OPTIONAL { ?work cdm:work_date_document ?date }
}
LIMIT 10`;
  const res = await runSparql(sparql);
  const seen = new Set<string>();
  const out: ResolvedWork[] = [];
  for (const row of res.results.bindings) {
    const work = val(row, 'work');
    if (!work || seen.has(work)) continue;
    seen.add(work);
    out.push({
      work,
      celex: val(row, 'celex'),
      title: val(row, 'title'),
      typeCode: lastSegment(val(row, 'type')),
      documentDate: val(row, 'date'),
    });
  }
  return out;
}

/** Resolve free-form input (CELEX, "YYYY/NNNN", or a common name) to zero/one/many candidate
 *  EU Works. Never requires the caller to write SPARQL. */
async function resolveDirective(
  input: string,
): Promise<{ resolved?: ResolvedWork; candidates?: ResolvedWork[] }> {
  const trimmed = input.trim();
  const compact = trimmed.toUpperCase().replace(/\s+/g, '');

  if (CELEX_RE.test(compact)) {
    const found = await resolveByCelex(compact);
    if (found.length) return { resolved: found[0] };
    return {};
  }

  const natMatch = NATURAL_NUMBER_RE.exec(trimmed);
  if (natMatch) {
    const candidates = await resolveByNaturalNumber(natMatch[1], natMatch[2]);
    if (candidates.length === 1) return { resolved: candidates[0] };
    if (candidates.length > 1) return { candidates };
    return {};
  }

  const aliasKey = trimmed.toLowerCase().replace(/\s+/g, ' ').trim();
  const aliasCelex = DIRECTIVE_ALIASES[aliasKey];
  if (aliasCelex) {
    const found = await resolveByCelex(aliasCelex);
    if (found.length) return { resolved: found[0] };
  }

  // Free-text title search: try as a Directive first, then a Regulation, then unrestricted.
  for (const type of ['DIR', 'REG', undefined]) {
    const candidates = await resolveByTitle(trimmed, type);
    if (candidates.length === 1) return { resolved: candidates[0] };
    if (candidates.length > 1) return { candidates: candidates.slice(0, 5) };
  }
  return {};
}

interface NimRow {
  countryIso3: string;
  title: string | null;
  documentDate: string | null;
  notificationDate: string | null;
  officialJournalDate: string | null;
  officialJournalName: string | null;
  officialJournalNumber: string | null;
  typeAct: string | null;
}

async function fetchNationalMeasures(workUri: string): Promise<NimRow[]> {
  const sparql = `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT DISTINCT ?nim ?country ?title ?docdate ?notif ?ojdate ?ojname ?ojnum ?typeact WHERE {
  ?nim cdm:measure_national_implementing_implements_resource_legal <${workUri}> ;
       cdm:measure_national_implementing_implemented_by_country ?country .
  OPTIONAL { ?nim cdm:work_title ?title }
  OPTIONAL { ?nim cdm:work_date_document ?docdate }
  OPTIONAL { ?nim cdm:measure_national_implementing_date_notification ?notif }
  OPTIONAL { ?nim cdm:measure_national_implementing_date_official_journal ?ojdate }
  OPTIONAL { ?nim cdm:measure_national_implementing_name_official_journal ?ojname }
  OPTIONAL { ?nim cdm:measure_national_implementing_number_official_journal ?ojnum }
  OPTIONAL { ?nim cdm:measure_national_implementing_type_act ?typeact }
}
LIMIT 3000`;
  const res = await runSparql(sparql);
  const out: NimRow[] = [];
  for (const row of res.results.bindings) {
    const iso3 = countryIso3FromUri(val(row, 'country'));
    if (!iso3) continue;
    out.push({
      countryIso3: iso3,
      title: val(row, 'title'),
      documentDate: val(row, 'docdate'),
      notificationDate: val(row, 'notif'),
      officialJournalDate: nullSentinelDate(val(row, 'ojdate')),
      officialJournalName: val(row, 'ojname'),
      officialJournalNumber: val(row, 'ojnum'),
      typeAct: val(row, 'typeact'),
    });
  }
  return out;
}

function resolveMemberStateFilter(raw: string): MemberState | null {
  const q = raw.trim();
  const upper = q.toUpperCase();
  for (const m of EU_MEMBER_STATES) {
    if (m.iso3 === upper || m.iso2 === upper || m.name.toUpperCase() === upper) return m;
  }
  return null;
}

async function transpositionMeasures(args: Record<string, unknown>) {
  const input = String(args.directive ?? '').trim();
  if (!input) {
    throw new Error('`directive` is required — give a CELEX number (e.g. 32019L1937), the "2019/1937" form, or a common name (e.g. "Whistleblower Directive").');
  }
  const limitPerState = clampLimit(args.limit_per_state, 10, 50);
  let stateFilter: MemberState | null = null;
  if (args.member_state) {
    stateFilter = resolveMemberStateFilter(String(args.member_state));
    if (!stateFilter) {
      throw new Error(`\`member_state\` "${String(args.member_state)}" is not a recognised current EU member state. Use an English name, ISO2 (e.g. "DE"), or ISO3 (e.g. "DEU") code.`);
    }
  }

  const { resolved, candidates } = await resolveDirective(input);
  if (!resolved) {
    if (candidates && candidates.length) {
      return {
        found: false,
        input,
        candidates: candidates.map((c) => ({
          celex: c.celex,
          title: c.title,
          type: c.typeCode,
          type_label: c.typeCode ? RESOURCE_TYPE_HINTS[c.typeCode] ?? c.typeCode : null,
        })),
        note: `Multiple EU documents matched "${input}". Give the CELEX number of the one you mean.`,
        source: 'CELLAR SPARQL endpoint, Publications Office of the European Union',
        source_url: SPARQL,
      };
    }
    return {
      found: false,
      input,
      note: `No EU directive or regulation matches "${input}". Give a CELEX number (e.g. 32019L1937 for the Whistleblower Directive, 32016R0679 for GDPR), the "2019/1937" form, or try cellar_search_works first.`,
      source: 'CELLAR SPARQL endpoint, Publications Office of the European Union',
      source_url: SPARQL,
    };
  }

  const typeCode = resolved.typeCode;
  const typeLabel = typeCode ? RESOURCE_TYPE_HINTS[typeCode] ?? typeCode : null;
  const isDirective = !!typeCode && /^DIR/.test(typeCode);
  const isRegulation = !!typeCode && /^REG/.test(typeCode);

  const nimRows = await fetchNationalMeasures(resolved.work);

  const resolvedInfo = {
    celex: resolved.celex,
    title: resolved.title,
    document_date: resolved.documentDate,
    type: typeCode,
    type_label: typeLabel,
    eurlex_url: resolved.celex ? `${EURLEX_DOC}${encodeURIComponent(resolved.celex)}` : null,
  };

  if (isRegulation) {
    return {
      found: true,
      input,
      resolved: resolvedInfo,
      transposition_applies: false,
      note: `${resolvedInfo.celex ?? input} is a Regulation. Under Article 288 TFEU, regulations are directly applicable in every Member State in their entirety — they are not transposed into national law, so there are no national implementing measures to report.`,
      unexpected_national_measures: nimRows.length
        ? nimRows.length
        : undefined,
      source: 'CELLAR SPARQL endpoint, national transposition records, Publications Office of the European Union',
      source_url: SPARQL,
    };
  }

  if (!isDirective) {
    return {
      found: true,
      input,
      resolved: resolvedInfo,
      transposition_applies: false,
      note: `${resolvedInfo.celex ?? input} is ${typeLabel ? `a ${typeLabel}` : 'not a Directive'}, which this tool does not track member-state transposition for. ${
        nimRows.length
          ? `CELLAR nonetheless records ${nimRows.length} national-implementing-measure link(s) for it — unusual for this act type, shown below for completeness.`
          : 'No national implementing measures are recorded for it.'
      }`,
      national_measures_found: nimRows.length,
      source: 'CELLAR SPARQL endpoint, national transposition records, Publications Office of the European Union',
      source_url: SPARQL,
    };
  }

  // Directive: group by member state, filling gaps explicitly.
  const byIso3 = new Map<string, NimRow[]>();
  const otherJurisdictions = new Map<string, NimRow[]>();
  for (const row of nimRows) {
    const bucket = EU_BY_ISO3.has(row.countryIso3) ? byIso3 : otherJurisdictions;
    const list = bucket.get(row.countryIso3) ?? [];
    list.push(row);
    bucket.set(row.countryIso3, list);
  }
  // Rank by subject-word overlap with the directive's own title first (best signal CELLAR's
  // data supports for "is this measure actually about the directive"), then newest
  // document_date first within a tier — see the ORDERING note above `MemberState`.
  const directiveWordSets = await fetchDirectiveTitleWordSets(resolved.work);
  const rankMeasure = (a: NimRow, b: NimRow) => {
    const sa = subjectScore(a.title, directiveWordSets);
    const sb = subjectScore(b.title, directiveWordSets);
    if (sa !== sb) return sb - sa;
    return (b.documentDate ?? '0000').localeCompare(a.documentDate ?? '0000');
  };
  for (const list of byIso3.values()) list.sort(rankMeasure);
  for (const list of otherJurisdictions.values()) list.sort(rankMeasure);

  const statesToReport = stateFilter ? [stateFilter] : EU_MEMBER_STATES;
  const states = statesToReport.map((m) => {
    const rows = byIso3.get(m.iso3) ?? [];
    const pack = NATIONAL_PACK_BY_ISO3[m.iso3] ?? null;
    return {
      country_code: m.iso3,
      country_code_iso2: m.iso2,
      country_name: m.name,
      has_measures: rows.length > 0,
      measure_count: rows.length,
      measures: rows.slice(0, limitPerState).map((r) => ({
        title: r.title,
        type_of_act: r.typeAct,
        document_date: r.documentDate,
        notification_date: r.notificationDate,
        official_journal: r.officialJournalName || r.officialJournalNumber
          ? { name: r.officialJournalName, number: r.officialJournalNumber, date: r.officialJournalDate }
          : null,
      })),
      truncated: rows.length > limitPerState,
      national_pack: pack
        ? {
            pack: pack.pack,
            search_tool: pack.search_tool,
            provision_tool: pack.provision_tool,
            identifier_needed: pack.identifier,
            how_to_use: `Call ${pack.search_tool} in the ${pack.pack} pack with words from a measure's title above to find it, then ${pack.provision_tool} (needs a ${pack.identifier}) for the provision text.`,
          }
        : null,
      note: rows.length === 0 ? 'none recorded' : undefined,
    };
  });

  const withMeasures = states.filter((s) => s.has_measures).length;

  return {
    found: true,
    input,
    resolved: resolvedInfo,
    transposition_applies: true,
    member_states_total: EU_MEMBER_STATES.length,
    member_states_with_measures: stateFilter ? undefined : withMeasures,
    member_states_without_measures: stateFilter ? undefined : EU_MEMBER_STATES.length - withMeasures,
    states,
    other_jurisdictions: otherJurisdictions.size
      ? [...otherJurisdictions.entries()].map(([iso3, rows]) => ({
          country_code: iso3,
          measure_count: rows.length,
          measures: rows.slice(0, limitPerState).map((r) => ({
            title: r.title,
            type_of_act: r.typeAct,
            document_date: r.documentDate,
          })),
          note: 'Not a current EU member state — CELLAR still carries this record (e.g. a pre-withdrawal or EEA notification).',
        }))
      : undefined,
    source: 'CELLAR SPARQL endpoint, national transposition records, Publications Office of the European Union',
    source_url: SPARQL,
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'cellar_search_works',
    description:
      'Full-text search of EVERY document the Publications Office of the European Union has issued — Official Journal acts, treaties, consolidated texts, COM proposals, Court of Justice judgments and preparatory work — by title, from the CELLAR repository. AUTHORITATIVE for "what has the EU published about X": this is the publisher of record, so it returns the CELEX number, the document date, the resource type and a direct EUR-Lex link, not a summary of one. PREFER OVER WEB SEARCH for any question about EU legal or official documents. Unlike the curated `eur-lex` pack, this searches all resource types, not a hand-kept list of named acts.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Words or a phrase to find in the document title, e.g. "artificial intelligence" or "carbon border adjustment". Matched against the Publications Office full-text index.',
        },
        resource_type: {
          type: 'string',
          description:
            'Optional resource-type code to restrict to, e.g. REG (Regulation), DIR (Directive), DEC (Decision), JUDG (judgment), COM (Commission document), CONS_TEXT (consolidated text), TREATY.',
        },
        since: {
          type: 'string',
          description: 'Optional earliest document date, ISO YYYY-MM-DD.',
        },
        until: {
          type: 'string',
          description: 'Optional latest document date, ISO YYYY-MM-DD.',
        },
        limit: { type: 'number', description: 'Maximum works to return (default 20, max 100).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'cellar_work',
    description:
      'Full metadata for one EU document from the Publications Office CELLAR repository, looked up by CELEX number (e.g. 32024R1689 for the AI Act) or by CELLAR UUID. Returns every English title on record, the document and in-force dates, the resource type, the EuroVoc subject concepts it is indexed under, and the authoring bodies. AUTHORITATIVE for the identity and classification of an EU act — this is the publisher\'s own catalogue entry.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        celex: {
          type: 'string',
          description:
            'CELEX identifier, e.g. 32016R0679 (GDPR), 32024R1689 (AI Act), 62024CJ0123 (a judgment). Give this OR cellar_id.',
        },
        cellar_id: {
          type: 'string',
          description:
            'CELLAR UUID as it appears in a publications.europa.eu/resource/cellar/<id> URI. Give this OR celex.',
        },
      },
      required: [],
    },
  },
  {
    name: 'cellar_sparql',
    description:
      'Run your own read-only SPARQL SELECT or ASK against the Publications Office of the European Union CELLAR endpoint, for EU-document questions no purpose-built tool covers — citation graphs, amendment chains, EuroVoc concept traversal, cross-institution counts. The Common Data Model prefix `cdm:` is <http://publications.europa.eu/ontology/cdm#>. Writes (INSERT/DELETE/LOAD/CLEAR) are refused, and results are capped.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'A SPARQL SELECT or ASK query. Virtuoso full-text search is available as `?lit bif:contains "\'phrase\'"`. CELEX literals are typed xsd:string — a plain string will match nothing.',
        },
        limit: {
          type: 'number',
          description:
            'Maximum rows to return (default 50, max 500). Applied on top of any LIMIT already in the query.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'eu_transposition_measures',
    description:
      'For an EU Directive, the national implementing measures (NIM) that each member state has notified to the European Commission — the Publications Office\'s own transposition tracker, read live from CELLAR. Give a CELEX number (e.g. "32019L1937" for the Whistleblower Directive), the "2019/1937" short form, or a common name (e.g. "Whistleblower Directive", "GDPR"). For a Directive, returns every member state with its measure(s) — title, type of act, document date, notification date, national Official Journal citation — and member states with NO recorded measure are listed explicitly as "none recorded", never dropped. A member state can notify dozens of measures (France has 36 for the Whistleblower Directive, Czechia 80, Croatia 93), mixing the actual transposing act with older provisions CELLAR also links — CELLAR itself does not flag which measure is "the" one, so measures within each state are ordered by how closely a measure\'s own title echoes the directive\'s own title (read in whichever language scores best), then by newest document date, which in practice surfaces the real transposing act first or near first; `limit_per_state` (default 10) then truncates that ranked list, with `truncated: true` meaning more exist. Where a live Pipeworx national-legislation pack covers that state (Germany/de-gesetze, Austria/at-ris, Italy/it-normattiva, Netherlands/nl-wetten, France/france-legi, Spain/boe-legislacion) the matching pack and tools are named so you can drill into the actual provision text — no SPARQL required anywhere in this chain. A Regulation is answered directly: regulations are not transposed (Article 288 TFEU), so this says that plainly rather than returning an empty list.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        directive: {
          type: 'string',
          description: 'CELEX number ("32019L1937"), short form ("2019/1937"), or common name ("Whistleblower Directive", "GDPR").',
        },
        member_state: {
          type: 'string',
          description: 'Optional: restrict to one EU member state — English name, ISO2 ("DE"), or ISO3 ("DEU"). Omit to get all 27.',
        },
        limit_per_state: {
          type: 'number',
          description: 'Max measures listed per member state before truncation (default 10, max 50). Some directives have dozens of related national measures per state.',
        },
      },
      required: ['directive'],
    },
  },
];

// ── cellar_search_works ─────────────────────────────────────────────

async function searchWorks(args: Record<string, unknown>) {
  const query = String(args.query ?? '').trim();
  if (!query) throw new Error('`query` is required — give words or a phrase to find in the document title.');
  const limit = clampLimit(args.limit, 20, 100);
  const resourceType = args.resource_type ? String(args.resource_type).trim().toUpperCase() : null;
  const since = args.since ? String(args.since).trim() : null;
  const until = args.until ? String(args.until).trim() : null;

  for (const [label, v] of [['since', since], ['until', until]] as const) {
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      throw new Error(`\`${label}\` must be an ISO date, YYYY-MM-DD — got "${v}".`);
    }
  }

  const typeClause = resourceType
    ? `?work cdm:work_has_resource-type <http://publications.europa.eu/resource/authority/resource-type/${resourceType}> .`
    : '';
  const dateFilters: string[] = [];
  if (since) dateFilters.push(`?date >= "${since}"^^xsd:date`);
  if (until) dateFilters.push(`?date <= "${until}"^^xsd:date`);
  const dateClause = dateFilters.length
    ? `?work cdm:work_date_document ?date . FILTER(${dateFilters.join(' && ')})`
    : 'OPTIONAL { ?work cdm:work_date_document ?date }';

  // Trap 1: bif:contains, not FILTER(CONTAINS(...)).
  // Trap 3: language is taken from the expression URI, not lang(?title).
  const sparql = `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT DISTINCT ?work ?title ?celex ?date ?type WHERE {
  ?exp cdm:expression_belongs_to_work ?work ;
       cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/ENG> ;
       cdm:expression_title ?title .
  ?title bif:contains ${JSON.stringify(bifPhrase(query))} .
  ${typeClause}
  ${dateClause}
  OPTIONAL { ?work cdm:resource_legal_id_celex ?celex }
  OPTIONAL { ?work cdm:work_has_resource-type ?type }
}
LIMIT ${limit}`;

  const res = await runSparql(sparql);
  const seen = new Set<string>();
  const works = [] as Array<Record<string, unknown>>;
  for (const row of res.results.bindings) {
    const uri = val(row, 'work');
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    const celex = val(row, 'celex');
    const typeCode = lastSegment(val(row, 'type'));
    works.push({
      cellar_uri: uri,
      cellar_id: cellarIdFromUri(uri),
      celex,
      title: val(row, 'title'),
      document_date: val(row, 'date'),
      resource_type: typeCode,
      resource_type_label: typeCode ? (RESOURCE_TYPE_HINTS[typeCode] ?? null) : null,
      eurlex_url: celex ? `${EURLEX_DOC}${encodeURIComponent(celex)}` : null,
    });
  }

  return {
    query,
    resource_type: resourceType,
    since,
    until,
    count: works.length,
    works,
    source: 'CELLAR SPARQL endpoint, Publications Office of the European Union',
    source_url: SPARQL,
    note: works.length
      ? undefined
      : 'No titles matched. The index is over TITLE text only, not full document text — try fewer or more general words, or drop the resource_type filter.',
  };
}

// ── cellar_work ─────────────────────────────────────────────────────

async function work(args: Record<string, unknown>) {
  const celex = args.celex ? String(args.celex).trim().toUpperCase() : null;
  const cellarId = args.cellar_id ? String(args.cellar_id).trim().toLowerCase() : null;
  if (!celex && !cellarId) {
    throw new Error('Give either `celex` (e.g. 32024R1689) or `cellar_id` (the UUID in a .../resource/cellar/<id> URI).');
  }

  // Trap 2: the CELEX literal is typed. Without ^^xsd:string this matches
  // nothing and returns a clean, wrong, empty answer.
  const anchor = celex
    ? `?work cdm:resource_legal_id_celex "${sparqlString(celex)}"^^xsd:string .`
    : `BIND(<${CELLAR_RESOURCE}/${encodeURIComponent(cellarId as string)}> AS ?work)`;

  const sparql = `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
SELECT DISTINCT ?work ?title ?celex ?date ?inforce ?type ?subject ?subjectLabel ?author WHERE {
  ${anchor}
  OPTIONAL { ?exp cdm:expression_belongs_to_work ?work ;
                  cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/ENG> ;
                  cdm:expression_title ?title }
  OPTIONAL { ?work cdm:resource_legal_id_celex ?celex }
  OPTIONAL { ?work cdm:work_date_document ?date }
  OPTIONAL { ?work cdm:resource_legal_in-force ?inforce }
  OPTIONAL { ?work cdm:work_has_resource-type ?type }
  OPTIONAL { ?work cdm:work_is_about_concept_eurovoc ?subject .
             OPTIONAL { ?subject skos:prefLabel ?subjectLabel . FILTER(lang(?subjectLabel) = "en") } }
  OPTIONAL { ?work cdm:work_created_by_agent ?author }
}
LIMIT 400`;

  const res = await runSparql(sparql);
  const rows = res.results.bindings;
  if (!rows.length) {
    return {
      found: false,
      celex,
      cellar_id: cellarId,
      note: celex
        ? `No CELLAR Work carries CELEX ${celex}. Check the identifier: sector digit, year, type letter, number — e.g. 32024R1689. Consolidated texts carry a dated suffix such as 02014D0450-20260305.`
        : `No CELLAR Work at ${CELLAR_RESOURCE}/${cellarId}.`,
      source: 'CELLAR SPARQL endpoint, Publications Office of the European Union',
      source_url: SPARQL,
    };
  }

  // Trap 4: one row per (title x type x subject x author) combination.
  const titles = new Set<string>();
  const types = new Set<string>();
  const subjects = new Map<string, string | null>();
  const authors = new Set<string>();
  let uri: string | null = null;
  let resolvedCelex: string | null = celex;
  let date: string | null = null;
  let inforce: string | null = null;

  for (const row of rows) {
    uri = uri ?? val(row, 'work');
    resolvedCelex = resolvedCelex ?? val(row, 'celex');
    date = date ?? val(row, 'date');
    inforce = inforce ?? val(row, 'inforce');
    const t = val(row, 'title');
    if (t) titles.add(t);
    const ty = lastSegment(val(row, 'type'));
    if (ty) types.add(ty);
    const s = val(row, 'subject');
    if (s) subjects.set(s, val(row, 'subjectLabel'));
    const a = lastSegment(val(row, 'author'));
    if (a) authors.add(a);
  }

  const typeCodes = [...types];
  return {
    found: true,
    cellar_uri: uri,
    cellar_id: cellarIdFromUri(uri),
    celex: resolvedCelex,
    titles: [...titles],
    title: [...titles][0] ?? null,
    document_date: date,
    in_force: inforce === null ? null : inforce === '1' || inforce === 'true',
    resource_types: typeCodes.map((code) => ({ code, label: RESOURCE_TYPE_HINTS[code] ?? null })),
    eurovoc_subjects: [...subjects.entries()].map(([concept, label]) => ({
      concept_uri: concept,
      concept_id: lastSegment(concept),
      label,
    })),
    authors: [...authors],
    eurlex_url: resolvedCelex ? `${EURLEX_DOC}${encodeURIComponent(resolvedCelex)}` : null,
    source: 'CELLAR SPARQL endpoint, Publications Office of the European Union',
    source_url: SPARQL,
  };
}

// ── cellar_sparql ───────────────────────────────────────────────────

/**
 * SELECT/ASK only. The endpoint is read-only to anonymous callers anyway, but
 * refusing here means a caller gets a sentence explaining why rather than an
 * opaque Virtuoso error, and it keeps this tool's contract honest if the
 * endpoint's posture ever changes.
 */
const WRITE_KEYWORDS = /\b(INSERT|DELETE|LOAD|CLEAR|DROP|CREATE|COPY|MOVE|ADD|WITH)\b/i;

async function rawSparql(args: Record<string, unknown>) {
  const raw = String(args.query ?? '').trim();
  if (!raw) throw new Error('`query` is required — give a SPARQL SELECT or ASK query.');
  const limit = clampLimit(args.limit, 50, 500);

  // Strip comments before classifying, so a keyword inside a comment neither
  // trips the refusal nor hides a real write behind one.
  const stripped = raw.replace(/(^|\s)#[^\n]*/g, ' ');
  if (WRITE_KEYWORDS.test(stripped)) {
    throw new Error(
      'cellar_sparql runs SELECT and ASK queries only — INSERT, DELETE, LOAD, CLEAR, DROP, CREATE, COPY, MOVE, ADD and WITH are refused. Rewrite the query as a SELECT.',
    );
  }
  if (!/\b(SELECT|ASK)\b/i.test(stripped)) {
    throw new Error('Query must contain a SELECT or an ASK. CONSTRUCT and DESCRIBE are not supported by this tool.');
  }

  const hasLimit = /\bLIMIT\s+\d+/i.test(stripped);
  const query = hasLimit ? raw : `${raw}\nLIMIT ${limit}`;

  const res = await runSparql(query);
  const vars = res.head?.vars ?? [];
  const bindings = res.results.bindings.slice(0, limit);
  const rows = bindings.map((row) => {
    const out: Record<string, string | null> = {};
    for (const v of vars) out[v] = val(row, v);
    return out;
  });

  return {
    vars,
    row_count: rows.length,
    truncated: res.results.bindings.length > rows.length,
    rows,
    query_sent: query,
    source: 'CELLAR SPARQL endpoint, Publications Office of the European Union',
    source_url: SPARQL,
    note: rows.length
      ? undefined
      : 'The query ran and matched nothing. Two common causes: a CELEX literal written without ^^xsd:string (it will never match), and a title filter written with FILTER(CONTAINS(...)) instead of bif:contains.',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'cellar_search_works':
      return searchWorks(args);
    case 'cellar_work':
      return work(args);
    case 'cellar_sparql':
      return rawSparql(args);
    case 'eu_transposition_measures':
      return transpositionMeasures(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
