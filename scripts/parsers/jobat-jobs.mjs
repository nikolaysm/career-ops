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
// HONESTY CONTRACT: a Cloudflare challenge/block is NOT "zero jobs". It exits non-zero
// with a stderr reason so scan.mjs surfaces a real board failure, because silently
// reporting an empty result would let a blocked scan look like a successful empty one.
//
// stdout is ONLY the jobs JSON (local-parser JSON.parses it) — every diagnostic goes
// to stderr. Emitted fields are title/url/company/location; local-parser's
// normalizeParserJob drops anything else, so postedAt/description are deliberately absent.
//
// Usage:
//   node scripts/parsers/jobat-jobs.mjs [--pages N] [--dump-html FILE] [--from-html FILE]

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

const RESULTS_URL = 'https://www.jobat.be/nl/jobs/results';
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
    requestedUrl: RESULTS_URL,
    finalUrl: RESULTS_URL,
    bodyText,
    applyControls: [],
  });
  return verdict.code === 'bot_challenge' || verdict.code === 'access_blocked';
}

/**
 * Pull {title, url, company, location} rows out of a JobPosting / ItemList JSON-LD blob.
 * Job boards emit this so their postings surface in Google Jobs, which makes it a far
 * more stable extraction target than CSS selectors over a marketing-driven layout.
 *
 * @param {unknown} node - A parsed JSON-LD value (object, array, @graph, or ItemList).
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
function collectJobPostings(node) {
  /** @type {Array<{title: string, url: string, company: string, location: string}>} */
  const out = [];
  const seen = new Set();

  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (seen.has(value)) return; // cyclic @graph references
    seen.add(value);

    const types = [value['@type']].flat().filter(Boolean).map(String);
    if (types.some(t => t.toLowerCase() === 'jobposting')) {
      const job = normalizeJobPosting(value);
      if (job) out.push(job);
    }

    // ItemList wraps results as itemListElement[].item; @graph is the other common shape.
    for (const key of ['itemListElement', '@graph', 'item', 'mainEntity', 'itemList']) {
      if (value[key]) visit(value[key]);
    }
  };

  visit(node);
  return out;
}

/**
 * Map one schema.org JobPosting to the local-parser job shape. Returns null when the
 * required title/url pair is missing — local-parser would drop it anyway, and dropping
 * it here keeps the count honest.
 *
 * @param {Record<string, any>} posting
 * @returns {{title: string, url: string, company: string, location: string} | null}
 */
function normalizeJobPosting(posting) {
  const title = clean(posting.title ?? posting.name);
  const url = clean(posting.url ?? posting.sameAs);
  if (!title || !url) return null;

  const org = posting.hiringOrganization;
  const company = clean(typeof org === 'string' ? org : org?.name);

  return { title, url, company, location: extractLocation(posting.jobLocation) };
}

/**
 * Flatten schema.org jobLocation (a Place, or an array of them) into a display string.
 *
 * @param {unknown} jobLocation
 * @returns {string}
 */
function extractLocation(jobLocation) {
  const places = [jobLocation].flat().filter(Boolean);
  const names = [];
  for (const place of places) {
    if (typeof place === 'string') { names.push(clean(place)); continue; }
    if (!place || typeof place !== 'object') continue;
    const addr = /** @type {Record<string, any>} */ (place).address;
    if (typeof addr === 'string') { names.push(clean(addr)); continue; }
    const locality = clean(addr?.addressLocality);
    const region = clean(addr?.addressRegion);
    const combined = [locality, region].filter(Boolean).join(', ');
    if (combined) names.push(combined);
    else if (clean(/** @type {Record<string, any>} */ (place).name)) {
      names.push(clean(/** @type {Record<string, any>} */ (place).name));
    }
  }
  return [...new Set(names.filter(Boolean))].join(' · ');
}

/**
 * Decode entities and collapse whitespace. Titles arrive HTML-escaped
 * ("Verpleegkundige M/V &amp; Zorgkundige"), so decode before the scanner's
 * title_filter ever sees them.
 *
 * @param {unknown} value
 * @returns {string}
 */
function clean(value) {
  if (value === null || value === undefined) return '';
  return decodeEntities(String(value)).replace(/\s+/g, ' ').trim();
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

  /** @type {Array<{title: string, url: string, company: string, location: string}>} */
  const jobs = [];
  const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRe.exec(source)) !== null) {
    let parsed;
    try {
      parsed = JSON.parse(match[1].trim());
    } catch {
      continue; // one malformed blob must not sink the whole page
    }
    jobs.push(...collectJobPostings(parsed));
  }

  // Dedup on absolute URL — the same posting can appear in both an ItemList and a
  // standalone JobPosting blob.
  const byUrl = new Map();
  for (const job of jobs) if (!byUrl.has(job.url)) byUrl.set(job.url, job);
  return [...byUrl.values()];
}

/**
 * Build the results URL for a 1-based page number.
 *
 * @param {number} page
 * @returns {string}
 */
export function resultsUrlForPage(page) {
  if (page <= 1) return RESULTS_URL;
  const url = new URL(RESULTS_URL);
  url.searchParams.set('page', String(page));
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
 * @returns {{pages: number, dumpHtml: string, fromHtml: string}}
 */
export function parseArgs(argv) {
  const valueFor = (flag) => {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
  };
  const rawPages = Number(valueFor('--pages'));
  const pages = Number.isFinite(rawPages) && rawPages >= 1
    ? Math.min(Math.trunc(rawPages), MAX_PAGES_CAP)
    : 1;
  return { pages, dumpHtml: valueFor('--dump-html'), fromHtml: valueFor('--from-html') };
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
  const { pages, dumpHtml, fromHtml } = parseArgs(process.argv.slice(2));

  // Offline mode: parse a saved page. Used to develop/verify the extractor without
  // touching jobat.be (and to inspect a captured fixture).
  if (fromHtml) {
    const jobs = extractJobs(readFileSync(fromHtml, 'utf-8'));
    console.error(`[jobat] parsed ${jobs.length} job(s) from ${fromHtml}`);
    process.stdout.write(JSON.stringify({ jobs }));
    return;
  }

  const browser = await chromium.launch({ headless: true });
  /** @type {Array<{title: string, url: string, company: string, location: string}>} */
  const all = [];
  let blockedReason = '';

  try {
    // nl-BE so Jobat serves Dutch listings; the UA comes from the shared liveness
    // options, which are already tuned to not read as HeadlessChrome.
    const context = await browser.newContext({
      ...LIVENESS_CONTEXT_OPTIONS,
      locale: 'nl-BE',
      timezoneId: 'Europe/Brussels',
    });
    const page = await context.newPage();

    for (let pageNum = 1; pageNum <= pages; pageNum += 1) {
      const url = resultsUrlForPage(pageNum);
      assertJobatUrl(url);

      if (pageNum > 1) await sleep(jitteredDelayMs(THROTTLE_MS));

      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATE_TIMEOUT_MS,
      });
      await page.waitForTimeout(HYDRATION_WAIT_MS);
      if (pageNum === 1) await acceptConsent(page);

      const html = await page.content();
      if (dumpHtml && pageNum === 1) {
        writeFileSync(dumpHtml, html);
        console.error(`[jobat] wrote ${html.length} bytes of page 1 HTML to ${dumpHtml}`);
      }

      let jobs;
      try {
        jobs = extractJobs(html);
      } catch (err) {
        blockedReason = `${err instanceof Error ? err.message : String(err)} (HTTP ${response?.status() ?? '?'}, page ${pageNum})`;
        break;
      }

      console.error(`[jobat] page ${pageNum}: ${jobs.length} job(s)`);
      if (!jobs.length) break; // no more results (or nothing extractable) — stop paging
      all.push(...jobs);
    }
  } finally {
    await browser.close().catch(() => { /* best effort */ });
  }

  if (blockedReason) throw new Error(blockedReason);

  const byUrl = new Map();
  for (const job of all) if (!byUrl.has(job.url)) byUrl.set(job.url, job);
  const jobs = [...byUrl.values()];

  if (!jobs.length) {
    // No JSON-LD found and no block detected: the page shape is not what this parser
    // expects. Fail loudly rather than reporting a confident empty board.
    throw new Error(
      'jobat: no JobPosting JSON-LD found and no anti-bot block detected — the results '
      + 'page layout may have changed. Re-run with --dump-html to capture it for inspection.',
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
