// tests/scripts/parsers/jobat-jobs.test.mjs — coverage for the pure extraction logic in
// scripts/parsers/jobat-jobs.mjs (the Jobat.be local-parser script).
//
// The card markup below mirrors a real Feb-2026 capture of
// /nl/jobs/results/administratief-bediende (50 cards/page), against which extractJobs()
// was verified end to end. Notably there is NO JobPosting JSON-LD on that page — only a
// BreadcrumbList — so extraction reads the server-rendered cards.
//
// The Playwright navigation path is deliberately NOT exercised here — jobat.be sits
// behind Cloudflare Bot Management, so any live call would be flaky and
// network-dependent. Same split as tests/liveness-core.test.mjs vs liveness-browser.mjs,
// and the pattern providers/README.md mandates: "RSS/HTML providers should export their
// pure parser function for direct unit testing."
//
// Auto-discovered by test-all.mjs (tests/**/*.test.mjs, #1440) and imported in-process
// alongside every other suite, so this file must NEVER exit the process itself; only
// pass()/fail() from ./helpers.mjs.
import { pass, fail } from '../../helpers.mjs';
import {
  extractJobs,
  looksBlocked,
  buildResultsUrl,
  slugifyKeyword,
  parseArgs,
} from '../../../scripts/parsers/jobat-jobs.mjs';

console.log('\njobat-jobs.mjs — Jobat.be local-parser extraction');

/**
 * One result card in the shape Jobat actually renders. `omit` drops a field so the
 * required-field guards can be exercised.
 */
const card = ({
  id = '5278189',
  title = 'Administratief bediende planning',
  href = '/nl/jobs/administratief-bediende-planning/job_5278189',
  company = 'Afkor nv',
  location = 'Marke',
  omit = '',
} = {}) => `
<div id="article_${id}" class="jobResults-card open " data-tealium-id="resultaat-single-job"${omit === 'href' ? '' : ` data-id="${href}"`} data-jobnav data-jobid="${id}" data-index="4">
    <h2 class="jobTitle">
        ${omit === 'title' ? '' : `<a href="${href}" onclick="event.preventDefault();">${title}</a>`}
    </h2>
    <ul class="jobCard-details">
        <li class="jobCard-company">
                <a href="/nl/jobs/bedrijven/afkor-nv/32924" onclick="event.preventDefault();">${company}</a>
        </li>
        <li class="jobCard-location">
${location}        </li>
            <li>Onbepaalde duur</li>
    </ul>
</div>`;

const page = (...cards) => `<html><body><div class="jobResults">${cards.join('\n')}</div></body></html>`;

// ── 1. A normal results page yields one row per card, fully populated ──
{
  // Given a page with two result cards
  const html = page(
    card({ id: '1', title: 'Backend Developer', href: '/nl/jobs/backend-developer/job_1', company: 'Acme NV', location: 'Antwerpen' }),
    card({ id: '2', title: 'DevOps Engineer', href: '/nl/jobs/devops-engineer/job_2', company: 'Globex', location: 'Gent' }),
  );

  // When the page is parsed
  const jobs = extractJobs(html);

  // Then each card becomes a job with title/url/company/location
  const ok = jobs.length === 2
    && jobs[0].title === 'Backend Developer'
    && jobs[0].company === 'Acme NV'
    && jobs[0].location === 'Antwerpen'
    && jobs[1].title === 'DevOps Engineer'
    && jobs[1].location === 'Gent';
  if (ok) pass('result cards yield title/url/company/location rows');
  else fail(`card extraction wrong: ${JSON.stringify(jobs)}`);
}

// ── 2. Relative card paths are absolutised against the jobat.be origin ──
{
  // Given a card whose data-id is a site-relative path (as Jobat emits)
  const html = page(card({ href: '/nl/jobs/backend-developer/job_99' }));

  // When the page is parsed
  const [job] = extractJobs(html);

  // Then the emitted URL is absolute, so the scanner can dedup and open it
  if (job && job.url === 'https://www.jobat.be/nl/jobs/backend-developer/job_99') {
    pass('relative card paths are resolved to absolute jobat.be URLs');
  } else {
    fail(`relative URL not absolutised: ${JSON.stringify(job)}`);
  }
}

// ── 3. A challenge/block page must never look like an empty board ──
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

// ── 4. A card-less page returns [] and is not misreported as a block ──
{
  // Given a real page carrying no result cards
  const html = '<html><body>Geen vacatures gevonden</body></html>';

  // When it is parsed
  const jobs = extractJobs(html);

  // Then the result is empty and no block is claimed (main() decides what that means)
  if (jobs.length === 0 && !looksBlocked(html)) {
    pass('card-less page yields [] and is not mistaken for a block');
  } else {
    fail(`card-less page mishandled: jobs=${jobs.length} blocked=${looksBlocked(html)}`);
  }
}

// ── 5. Cards missing the required title or link are dropped ──
{
  // Given one card with no title and one with no link, plus a valid card
  const html = page(
    card({ id: '10', omit: 'title' }),
    card({ id: '11', href: '', omit: 'href' }),
    card({ id: '12', title: 'Valid Job', href: '/nl/jobs/valid/job_12' }),
  );

  // When the page is parsed
  const jobs = extractJobs(html);

  // Then only the complete card survives (local-parser requires title+url anyway)
  if (jobs.length === 1 && jobs[0].title === 'Valid Job') {
    pass('cards missing title or link are dropped');
  } else {
    fail(`incomplete cards not filtered: ${JSON.stringify(jobs.map(j => j.title))}`);
  }
}

// ── 6. HTML-escaped text is decoded before the scanner's filters see it ──
{
  // Given a title and location carrying entities, as Jobat emits them
  const html = page(card({
    title: 'Verpleegkundige M/V &amp; Zorgkundige',
    location: 'Anci&#235;nniteit',
  }));

  // When the page is parsed
  const [job] = extractJobs(html);

  // Then both are decoded (an un-decoded "&amp;" would break keyword matching)
  if (job && job.title === 'Verpleegkundige M/V & Zorgkundige' && job.location === 'Anciënniteit') {
    pass('HTML entities in title and location are decoded');
  } else {
    fail(`entities not decoded: ${JSON.stringify(job)}`);
  }
}

// ── 7. Whitespace-padded cells are collapsed ──
{
  // Given the location cell's real markup, which is newline- and indent-padded
  const html = page(card({ location: '   Sint-Niklaas   ' }));

  // When the page is parsed
  const [job] = extractJobs(html);

  // Then the location is a clean single-line value
  if (job && job.location === 'Sint-Niklaas') pass('padded card cells are whitespace-collapsed');
  else fail(`whitespace not collapsed: "${job && job.location}"`);
}

// ── 8. The same posting listed twice is deduped on URL ──
{
  // Given two cards pointing at the same posting (Jobat repeats promoted listings)
  const html = page(
    card({ id: '20', href: '/nl/jobs/same/job_20' }),
    card({ id: '20', href: '/nl/jobs/same/job_20' }),
  );

  // When the page is parsed
  const jobs = extractJobs(html);

  // Then it appears once
  if (jobs.length === 1) pass('duplicate cards are deduped on absolute URL');
  else fail(`expected 1 deduped job, got ${jobs.length}`);
}

// ── 9. Search URLs put the keyword in the path and paginate with ?pagenum ──
{
  // Given a keyword and page numbers
  // When URLs are built
  const bare = buildResultsUrl();
  const kw = buildResultsUrl({ keyword: 'Backend Developer' });
  const paged = buildResultsUrl({ keyword: 'Backend Developer', page: 3 });

  // Then the keyword is a path slug and pagination uses ?pagenum=N (not ?page=N)
  const ok = bare === 'https://www.jobat.be/nl/jobs/results'
    && kw === 'https://www.jobat.be/nl/jobs/results/backend-developer'
    && paged === 'https://www.jobat.be/nl/jobs/results/backend-developer?pagenum=3';
  if (ok) pass('buildResultsUrl slugs the keyword into the path and pages via ?pagenum');
  else fail(`URL building wrong: "${bare}" / "${kw}" / "${paged}"`);
}

// ── 10. Keyword slugs are lowercased, accent-stripped and punctuation-collapsed ──
{
  // Given keywords with spaces, case, accents and punctuation
  // When they are slugified
  const results = [
    slugifyKeyword('Full Stack'),
    slugifyKeyword('Sécurité'),
    slugifyKeyword('  Platform   Engineer  '),
  ];

  // Then each is a clean path segment with no leading/trailing dashes
  if (results[0] === 'full-stack' && results[1] === 'securite' && results[2] === 'platform-engineer') {
    pass('slugifyKeyword lowercases, strips accents and collapses punctuation');
  } else {
    fail(`slugify wrong: ${JSON.stringify(results)}`);
  }
}

// ── 11. --keyword repeats and --pages is clamped ──
{
  // Given repeated keywords (one dupe) and an absurd/invalid page count
  // When args are parsed
  const many = parseArgs(['--keyword', 'Backend', '--keyword', 'Python', '--keyword', 'Backend']);
  const huge = parseArgs(['--pages', '99']);
  const bad = parseArgs(['--pages', 'abc']);

  // Then keywords are deduped and the page count is capped, never below 1
  const ok = many.keywords.length === 2
    && many.keywords[0] === 'Backend' && many.keywords[1] === 'Python'
    && many.pages === 1 && huge.pages === 10 && bad.pages === 1;
  if (ok) pass('--keyword repeats are deduped and --pages is clamped to the cap');
  else fail(`arg parsing wrong: ${JSON.stringify({ many, huge: huge.pages, bad: bad.pages })}`);
}
