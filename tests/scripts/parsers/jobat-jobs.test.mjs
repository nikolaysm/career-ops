// tests/scripts/parsers/jobat-jobs.test.mjs — coverage for the pure extraction logic in
// scripts/parsers/jobat-jobs.mjs (the Jobat.be local-parser script).
//
// The Playwright navigation path is deliberately NOT exercised here — jobat.be is behind
// Cloudflare Bot Management, so any live call would be flaky and network-dependent. Same
// split as tests/liveness-core.test.mjs vs liveness-browser.mjs, and the pattern
// providers/README.md mandates: "RSS/HTML providers should export their pure parser
// function for direct unit testing."
//
// Auto-discovered by test-all.mjs (tests/**/*.test.mjs, #1440) and imported in-process
// alongside every other suite, so this file must NEVER exit the process itself; only
// pass()/fail() from ./helpers.mjs.
import { pass, fail } from '../../helpers.mjs';
import { extractJobs, looksBlocked, resultsUrlForPage, parseArgs } from '../../../scripts/parsers/jobat-jobs.mjs';

console.log('\njobat-jobs.mjs — Jobat.be local-parser extraction');

/** Wrap JSON-LD in a minimal results-page shell. */
const pageWith = (...blobs) =>
  `<html><head>${blobs.map(b => `<script type="application/ld+json">${b}</script>`).join('')}</head><body>vacatures</body></html>`;

const posting = ({ title = 'AI Engineer', url = 'https://www.jobat.be/nl/jobs/1', company = 'Acme NV', locality = 'Antwerpen' } = {}) =>
  JSON.stringify({
    '@type': 'JobPosting',
    title,
    url,
    hiringOrganization: { '@type': 'Organization', name: company },
    jobLocation: { '@type': 'Place', address: { addressLocality: locality } },
  });

// ── 1. An ItemList of JobPostings is the normal results-page shape ──
{
  // Given a results page whose JSON-LD wraps postings in ItemList/ListItem
  const html = pageWith(JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, item: JSON.parse(posting({ title: 'Data Engineer', url: 'https://www.jobat.be/nl/jobs/11' })) },
      { '@type': 'ListItem', position: 2, item: JSON.parse(posting({ title: 'ML Engineer', url: 'https://www.jobat.be/nl/jobs/22' })) },
    ],
  }));

  // When the page is parsed
  const jobs = extractJobs(html);

  // Then both postings are unwrapped with their fields mapped
  if (jobs.length === 2 && jobs[0].title === 'Data Engineer' && jobs[1].url === 'https://www.jobat.be/nl/jobs/22'
      && jobs[0].company === 'Acme NV' && jobs[0].location === 'Antwerpen') {
    pass('ItemList of JobPostings is unwrapped into title/url/company/location rows');
  } else {
    fail(`ItemList extraction wrong: ${JSON.stringify(jobs)}`);
  }
}

// ── 2. A challenge/block page must never look like an empty board ──
{
  // Given Cloudflare served a block page instead of listings (verified live on jobat.be)
  const blocked = '<html><head><title>Attention Required! | Cloudflare</title></head>'
    + '<body>Sorry, you have been blocked. You are unable to access jobat.be. Ray ID: a23659d4</body></html>';

  // When the parser is handed that page
  let threw = false;
  let message = '';
  try {
    extractJobs(blocked);
  } catch (err) {
    threw = true;
    message = err instanceof Error ? err.message : String(err);
  }

  // Then it throws rather than returning zero jobs, so scan.mjs reports a real failure
  if (threw && /anti-bot|blocked/i.test(message)) {
    pass('anti-bot block page throws instead of reporting an empty board');
  } else {
    fail(`block page should have thrown a blocked error, got threw=${threw} msg="${message}"`);
  }

  // And the shared detector agrees it is a block page
  if (looksBlocked(blocked)) pass('looksBlocked() recognises the Cloudflare block page');
  else fail('looksBlocked() failed to recognise the Cloudflare block page');
}

// ── 3. A genuinely empty results page yields no jobs, without throwing ──
{
  // Given a real page that simply carries no postings
  const html = '<html><head></head><body>Geen vacatures gevonden</body></html>';

  // When it is parsed
  const jobs = extractJobs(html);

  // Then the result is empty and no block is claimed (the caller decides what that means)
  if (jobs.length === 0 && !looksBlocked(html)) {
    pass('empty results page yields [] and is not mistaken for a block');
  } else {
    fail(`empty page mishandled: jobs=${jobs.length} blocked=${looksBlocked(html)}`);
  }
}

// ── 4. Rows missing the required title/url pair are dropped ──
{
  // Given postings where one lacks a url and another lacks a title
  const html = pageWith(
    JSON.stringify({ '@type': 'JobPosting', name: 'No URL Job' }),
    JSON.stringify({ '@type': 'JobPosting', url: 'https://www.jobat.be/nl/jobs/99' }),
    posting({ title: 'Valid Job', url: 'https://www.jobat.be/nl/jobs/100' }),
  );

  // When the page is parsed
  const jobs = extractJobs(html);

  // Then only the complete posting survives
  if (jobs.length === 1 && jobs[0].title === 'Valid Job') {
    pass('postings missing title or url are dropped');
  } else {
    fail(`incomplete postings not filtered: ${JSON.stringify(jobs)}`);
  }
}

// ── 5. HTML-escaped titles are decoded before the scanner's title_filter sees them ──
{
  // Given a title carrying an HTML entity, as Jobat emits it
  const html = pageWith(posting({ title: 'Verpleegkundige M/V &amp; Zorgkundige' }));

  // When the page is parsed
  const [job] = extractJobs(html);

  // Then the entity is decoded (an un-decoded "&amp;" would break keyword matching)
  if (job && job.title === 'Verpleegkundige M/V & Zorgkundige') {
    pass('HTML entities in titles are decoded');
  } else {
    fail(`entity not decoded: ${JSON.stringify(job)}`);
  }
}

// ── 6. One malformed JSON-LD blob must not sink the whole page ──
{
  // Given a page with a broken blob alongside a valid posting
  const html = pageWith('{ this is not json }', posting({ title: 'Survivor', url: 'https://www.jobat.be/nl/jobs/7' }));

  // When the page is parsed
  const jobs = extractJobs(html);

  // Then the valid posting is still returned
  if (jobs.length === 1 && jobs[0].title === 'Survivor') {
    pass('a malformed JSON-LD blob is skipped without losing valid postings');
  } else {
    fail(`malformed blob broke extraction: ${JSON.stringify(jobs)}`);
  }
}

// ── 7. The same posting in two blobs is deduped on URL ──
{
  // Given a posting present both inside an ItemList and standalone
  const dup = posting({ title: 'AI Engineer', url: 'https://www.jobat.be/nl/jobs/500' });
  const html = pageWith(
    JSON.stringify({ '@type': 'ItemList', itemListElement: [{ '@type': 'ListItem', item: JSON.parse(dup) }] }),
    dup,
  );

  // When the page is parsed
  const jobs = extractJobs(html);

  // Then it appears once
  if (jobs.length === 1) pass('duplicate postings are deduped on absolute URL');
  else fail(`expected 1 deduped job, got ${jobs.length}`);
}

// ── 8. Multiple jobLocation places flatten into one display string ──
{
  // Given a posting listing two places
  const html = pageWith(JSON.stringify({
    '@type': 'JobPosting',
    title: 'Consultant',
    url: 'https://www.jobat.be/nl/jobs/300',
    jobLocation: [
      { '@type': 'Place', address: { addressLocality: 'Antwerpen' } },
      { '@type': 'Place', address: { addressLocality: 'Gent', addressRegion: 'Oost-Vlaanderen' } },
    ],
  }));

  // When the page is parsed
  const [job] = extractJobs(html);

  // Then both are represented, so location_filter can match either
  if (job && job.location.includes('Antwerpen') && job.location.includes('Gent')) {
    pass('multiple jobLocation entries flatten into one location string');
  } else {
    fail(`multi-location not flattened: ${JSON.stringify(job)}`);
  }
}

// ── 9. Pagination URLs stay on the canonical results path ──
{
  // Given page numbers at and above the first page
  // When URLs are built
  const first = resultsUrlForPage(1);
  const third = resultsUrlForPage(3);

  // Then page 1 is the bare URL and later pages carry ?page=N
  if (first === 'https://www.jobat.be/nl/jobs/results' && third === 'https://www.jobat.be/nl/jobs/results?page=3') {
    pass('resultsUrlForPage builds the bare URL for page 1 and ?page=N beyond it');
  } else {
    fail(`pagination URLs wrong: "${first}" / "${third}"`);
  }
}

// ── 10. --pages is clamped so a typo can't walk the whole board ──
{
  // Given an absurd and an invalid --pages value
  // When args are parsed
  const huge = parseArgs(['--pages', '99']);
  const bad = parseArgs(['--pages', 'abc']);
  const none = parseArgs([]);

  // Then the count is capped and always at least one page
  if (huge.pages === 10 && bad.pages === 1 && none.pages === 1) {
    pass('--pages is clamped to the cap and defaults to 1');
  } else {
    fail(`--pages clamping wrong: huge=${huge.pages} bad=${bad.pages} none=${none.pages}`);
  }
}
