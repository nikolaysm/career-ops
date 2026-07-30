#!/usr/bin/env node
// @ts-check
//
// jobat-jobs.mjs — local-parser script for Jobat.be (Belgian/Flemish job board).
//
// Invoked by providers/local-parser.mjs via a portals.yml entry:
//
//   - name: Jobat — Vlaanderen
//     careers_url: https://www.jobat.be/nl/jobs/results
//     scan_method: local_parser
//     parser:
//       command: node
//       script: scripts/parsers/jobat-jobs.mjs
//       args: ["--keyword", "Backend", "--keyword", "Python", "--pages", "2"]
//       format: jobs-json-v1
//       timeout_ms: 90000        # a browser launch needs more than the 20s default
//     enabled: true
//
// WHY A BROWSER (and why this is not providers/jobat.mjs):
// jobat.be serves no public jobs API — the results page is server-rendered, and the
// whole origin (HTML *and* static assets) sits behind Cloudflare Bot Management, which
// 403s plain HTTP from any User-Agent. Core providers are HTTP-only by contract
// (providers/_types.js pins `transport: 'http'`), and scan.mjs runs provider fetches
// through a 10-wide pool while the project rule is "never Playwright in parallel"
// (scan.mjs:1632, check-liveness.mjs:75). Routing through local-parser keeps the
// browser in one execFile'd subprocess for one board entry, with zero framework change.
// Same trick, same directory as the pracuj.pl parser referenced in liveness-browser.mjs.
//
// PAGE SHAPE (verified against a Feb-2026 capture of /nl/jobs/results/administratief-bediende):
// there is NO JobPosting JSON-LD — only a BreadcrumbList — so listings are read from the
// server-rendered cards, 50 per page:
//
//   <div id="article_5278189" class="jobResults-card open" data-jobid="5278189"
//        data-id="/nl/jobs/administratief-bediende-planning/job_5278189">
//     <h2 class="jobTitle"><a href="/nl/jobs/…/job_5278189">Administratief bediende planning</a></h2>
//     <ul class="jobCard-details">
//       <li class="jobCard-company"><a href="…">Afkor nv</a></li>
//       <li class="jobCard-location">Marke</li>
//       <li>Onbepaalde duur</li>
//     </ul>
//
// Keyword search is a PATH segment (/nl/jobs/results/{slug}) and pagination is
// ?pagenum=N — not the ?page=N most boards use.
//
// HONESTY CONTRACT: a Cloudflare challenge/block is NOT "zero jobs". It exits non-zero
// with a stderr reason so scan.mjs surfaces a real board failure, because silently
// reporting an empty result would let a blocked scan look like a successful empty one.
// A page that yields no cards and is not a block also fails loudly, since that means
// the layout changed rather than that the board is empty.
//
// stdout is ONLY the jobs JSON (local-parser JSON.parses it) — every diagnostic goes
// to stderr. Emitted fields are title/url/company/location; local-parser's
// normalizeParserJob drops anything else, so postedAt/description are deliberately absent.
//
// Usage:
//   node scripts/parsers/jobat-jobs.mjs [--keyword K]... [--pages N]
//                                       [--dump-html FILE] [--from-html FILE]

import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
import { classifyLiveness } from '../../liveness-core.mjs';
import {
  LIVENESS_CONTEXT_OPTIONS,
  jitteredDelayMs,
  rejectPrivateOrInvalid,
  sleep,
} from '../../liveness-browser.mjs';
import { decodeEntities } from '../../providers/_html-entities.mjs';

const ORIGIN = 'https://www.jobat.be';
const RESULTS_PATH = '/nl/jobs/results';
const ALLOWED_HOST = 'www.jobat.be';

const NAVIGATE_TIMEOUT_MS = 30_000;
const HYDRATION_WAIT_MS = 5_000;
const CONSENT_WAIT_MS = 4_000;
// Jobat's Cloudflare flags a session after only a handful of rapid hits, so pages are
// spaced with a jittered gap rather than a fixed cadence (see jitteredDelayMs).
const THROTTLE_MS = 4_000;
const MAX_PAGES_CAP = 10;

// Consent overlay ("Welkom bij Jobat" — House Of Recruitment Solutions). Tried in order;
// the first one present is clicked. Listings may be behind it, so this runs before parsing.
const CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  'button:has-text("Alles accepteren")',
  'button:has-text("Alles toestaan")',
  'button:has-text("Accepteer")',
  'button:has-text("Akkoord")',
];

/**
 * True when the HTML is an anti-bot interstitial or block page rather than content.
 *
 * Delegates to liveness-core's BOT_CHALLENGE_PATTERNS instead of re-deriving them —
 * it already recognises Cloudflare's "Attention Required", "Just a moment", Ray ID and
 * "performing security verification" variants, verified against a live jobat.be block page.
 *
 * @param {string} html
 * @returns {boolean}
 */
export function looksBlocked(html) {
  const bodyText = String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const verdict = classifyLiveness({
    status: 200,
    requestedUrl: ORIGIN + RESULTS_PATH,
    finalUrl: ORIGIN + RESULTS_PATH,
    bodyText,
    applyControls: [],
  });
  return verdict.code === 'bot_challenge' || verdict.code === 'access_blocked';
}

/**
 * Strip tags, decode entities, collapse whitespace. Card cells wrap their text in
 * anchors and carry generous indentation ("\n    Marke        "), and titles arrive
 * HTML-escaped, so both have to be normalised before the scanner's filters see them.
 *
 * @param {string} fragment
 * @returns {string}
 */
function textOf(fragment) {
  return decodeEntities(String(fragment || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * First capture group of `re` applied to `card`, as normalised text ('' when absent).
 *
 * @param {string} card
 * @param {RegExp} re
 * @returns {string}
 */
function matchText(card, re) {
  const m = card.match(re);
  return m ? textOf(m[1]) : '';
}

const CARD_START_RE = /<div[^>]*class="[^"]*\bjobResults-card\b[^"]*"[^>]*>/gi;
const TITLE_RE = /<h2[^>]*class="[^"]*\bjobTitle\b[^"]*"[^>]*>([\s\S]*?)<\/h2>/i;
const COMPANY_RE = /<li[^>]*class="[^"]*\bjobCard-company\b[^"]*"[^>]*>([\s\S]*?)<\/li>/i;
const LOCATION_RE = /<li[^>]*class="[^"]*\bjobCard-location\b[^"]*"[^>]*>([\s\S]*?)<\/li>/i;
// data-id carries the canonical posting path; the title anchor's href is the fallback.
const DATA_ID_RE = /data-id="([^"]+)"/i;
// Applied to the <h2> inner HTML only. Scanning the whole card would let a title anchor
// with an empty href fall through to the NEXT anchor — the company profile link — and
// emit that as the job URL.
const ANCHOR_HREF_RE = /<a[^>]+href="([^"]+)"/i;

/**
 * Slice the document into card-sized chunks. Cards are siblings with no distinctive
 * closing marker, so each runs from its opening div to the next card's (or EOF) —
 * enough to scope the per-field regexes without a full HTML parser, matching how the
 * other HTML providers in this repo (radancy, rheinmetall, deutschebahn) parse.
 *
 * @param {string} html
 * @returns {string[]}
 */
function sliceCards(html) {
  const starts = [];
  CARD_START_RE.lastIndex = 0;
  let m;
  while ((m = CARD_START_RE.exec(html)) !== null) starts.push(m.index);
  return starts.map((start, i) => html.slice(start, starts[i + 1] ?? html.length));
}

/**
 * Extract jobs from one results-page HTML document. Pure — this is the unit-tested seam.
 *
 * Throws on a challenge/block page so a blocked fetch can never be mistaken for an
 * empty board (see the HONESTY CONTRACT in the module header).
 *
 * @param {string} html
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function extractJobs(html) {
  const source = String(html || '');
  if (looksBlocked(source)) {
    throw new Error('jobat: blocked by anti-bot protection (Cloudflare) — no listings served');
  }

  const byUrl = new Map();
  for (const card of sliceCards(source)) {
    const titleBlock = (card.match(TITLE_RE) || [])[1] || '';
    const title = textOf(titleBlock);
    const href = (card.match(DATA_ID_RE) || titleBlock.match(ANCHOR_HREF_RE) || [])[1];
    if (!title || !href) continue; // local-parser requires both; keep the count honest

    let url;
    try {
      url = new URL(href.trim(), ORIGIN).href;
    } catch {
      continue;
    }
    if (byUrl.has(url)) continue;

    byUrl.set(url, {
      title,
      url,
      company: matchText(card, COMPANY_RE),
      location: matchText(card, LOCATION_RE),
    });
  }
  return [...byUrl.values()];
}

/**
 * Jobat puts the search term in the path (/nl/jobs/results/backend-developer), so a
 * keyword has to be slugified rather than query-encoded.
 *
 * Note: Jobat spells some punctuation out (".NET" appears as "-dot-net-"), which this
 * does not reproduce — plain alphanumeric keywords are what the scanner's target roles use.
 *
 * @param {string} keyword
 * @returns {string}
 */
export function slugifyKeyword(keyword) {
  return String(keyword || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // drop the combining marks NFKD split off ("Sécurité" → "securite")
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build a results URL for an optional keyword and a 1-based page number.
 * Pagination is ?pagenum=N (verified against a live capture) — not the more common ?page=N.
 *
 * @param {{keyword?: string, page?: number}} [options]
 * @returns {string}
 */
export function buildResultsUrl({ keyword = '', page = 1 } = {}) {
  const slug = slugifyKeyword(keyword);
  const url = new URL(ORIGIN + RESULTS_PATH + (slug ? `/${slug}` : ''));
  if (page > 1) url.searchParams.set('pagenum', String(page));
  return url.href;
}

/**
 * Assert a URL stays on jobat.be over https and is not private/loopback, reusing the
 * scanner's existing SSRF guard so this script can't be pointed at internal hosts.
 *
 * @param {string} url
 */
function assertJobatUrl(url) {
  const rejection = rejectPrivateOrInvalid(url);
  if (rejection) throw new Error(`jobat: refusing to navigate (${rejection.code}): ${rejection.reason}`);
  const { protocol, hostname } = new URL(url);
  if (protocol !== 'https:') throw new Error(`jobat: refusing non-https URL: ${url}`);
  if (hostname !== ALLOWED_HOST) throw new Error(`jobat: untrusted hostname "${hostname}"`);
}

/**
 * @param {string[]} argv
 * @returns {{keywords: string[], pages: number, dumpHtml: string, fromHtml: string}}
 */
export function parseArgs(argv) {
  const valueFor = (flag) => {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
  };
  // --keyword repeats, one search per keyword (mirrors vdab's keywords[]).
  const keywords = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--keyword') continue;
    const value = argv[i + 1];
    if (value && !value.startsWith('--')) keywords.push(value);
  }
  const rawPages = Number(valueFor('--pages'));
  const pages = Number.isFinite(rawPages) && rawPages >= 1
    ? Math.min(Math.trunc(rawPages), MAX_PAGES_CAP)
    : 1;
  return {
    keywords: [...new Set(keywords)],
    pages,
    dumpHtml: valueFor('--dump-html'),
    fromHtml: valueFor('--from-html'),
  };
}

/** Dismiss the consent overlay if present. Best-effort: absence is not an error. */
async function acceptConsent(page) {
  for (const selector of CONSENT_SELECTORS) {
    try {
      const el = await page.$(selector);
      if (!el) continue;
      await el.click({ timeout: 3_000 });
      console.error(`[jobat] consent accepted via ${selector}`);
      await page.waitForTimeout(CONSENT_WAIT_MS);
      return;
    } catch {
      // Overlay raced away or the click was intercepted — try the next candidate.
    }
  }
}

async function main() {
  const { keywords, pages, dumpHtml, fromHtml } = parseArgs(process.argv.slice(2));

  // Offline mode: parse a saved page. Used to develop/verify the extractor without
  // touching jobat.be (and to inspect a captured fixture).
  if (fromHtml) {
    const jobs = extractJobs(readFileSync(fromHtml, 'utf-8'));
    console.error(`[jobat] parsed ${jobs.length} job(s) from ${fromHtml}`);
    process.stdout.write(JSON.stringify({ jobs }));
    return;
  }

  // No keyword => the generic "newest vacancies" board.
  const searches = keywords.length ? keywords : [''];
  const browser = await chromium.launch({ headless: true });
  const byUrl = new Map();
  let blockedReason = '';
  let firstDumpWritten = false;

  try {
    // nl-BE so Jobat serves Dutch listings; the UA comes from the shared liveness
    // options, which are already tuned to not read as HeadlessChrome.
    const context = await browser.newContext({
      ...LIVENESS_CONTEXT_OPTIONS,
      locale: 'nl-BE',
      timezoneId: 'Europe/Brussels',
    });
    const page = await context.newPage();
    let requested = 0;
    let consentDone = false;

    outer:
    for (const keyword of searches) {
      for (let pageNum = 1; pageNum <= pages; pageNum += 1) {
        const url = buildResultsUrl({ keyword, page: pageNum });
        assertJobatUrl(url);

        if (requested > 0) await sleep(jitteredDelayMs(THROTTLE_MS));
        requested += 1;

        const response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: NAVIGATE_TIMEOUT_MS,
        });
        await page.waitForTimeout(HYDRATION_WAIT_MS);
        if (!consentDone) { await acceptConsent(page); consentDone = true; }

        const html = await page.content();
        if (dumpHtml && !firstDumpWritten) {
          writeFileSync(dumpHtml, html);
          firstDumpWritten = true;
          console.error(`[jobat] wrote ${html.length} bytes of HTML to ${dumpHtml}`);
        }

        let jobs;
        try {
          jobs = extractJobs(html);
        } catch (err) {
          // A block is terminal for the whole run: the session is flagged, so
          // continuing would only harden the block.
          blockedReason = `${err instanceof Error ? err.message : String(err)} (HTTP ${response?.status() ?? '?'}, ${keyword || 'newest'} p${pageNum})`;
          break outer;
        }

        console.error(`[jobat] ${keyword || 'newest'} p${pageNum}: ${jobs.length} card(s)`);
        for (const job of jobs) if (!byUrl.has(job.url)) byUrl.set(job.url, job);
        if (!jobs.length) break; // past the last page for this keyword
      }
    }
  } finally {
    await browser.close().catch(() => { /* best effort */ });
  }

  if (blockedReason) throw new Error(blockedReason);

  const jobs = [...byUrl.values()];
  if (!jobs.length) {
    // Not a block, yet no cards parsed: the layout changed. Fail loudly rather than
    // banking a confident empty board.
    throw new Error(
      'jobat: no job cards found and no anti-bot block detected — the results page '
      + 'layout may have changed. Re-run with --dump-html to capture it for inspection.',
    );
  }

  console.error(`[jobat] total ${jobs.length} unique job(s)`);
  process.stdout.write(JSON.stringify({ jobs }));
}

// Only run when executed directly, so the pure helpers can be imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[jobat] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
