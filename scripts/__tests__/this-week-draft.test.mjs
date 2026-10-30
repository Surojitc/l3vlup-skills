// The Thursday draft's rules (lib/this-week-draft.mjs), with no network and
// no model: deduplication and clustering, the deterministic shortlist, the
// sources a model may read, the site's validation rules mirrored, the
// assembly of a tool answer into an edition with every URL resolved from the
// lists this code built, the budget check, and the report.
import {
  FORECAST, HARD_STOP_USD, allowedPaths, assembleEdition, canonicalLink, checkDraftBudget, dedupe, extractText, normaliseTitle, readDraft, renderReport,
  shortlist, sourcesOf, validateDraft, weekEndingFor, DraftModelError, EDITION_TOOL,
} from '../../lib/this-week-draft.mjs';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`); };

/* ----------------------------------------------------------- dedupe -- */
const day = (d, h = 9) => `2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00.000Z`;
const items = [
  { title: 'Aon agrees to buy insurance broker USI from KKR for $17bn', link: 'https://a.example/aon-usi?utm=1', source: 'Reuters', vertical: 'ma', date: day(28), dealValue: '$17bn' },
  { title: 'Aon to acquire USI from KKR in $17 billion deal', link: 'https://b.example/aon', source: 'Bloomberg', vertical: 'ma', date: day(28, 11) },
  { title: 'Aon agrees to buy insurance broker USI from KKR for $17bn', link: 'https://a.example/aon-usi#top', source: 'Reuters', vertical: 'ma', date: day(28, 12) },
  { title: 'Millennium raises management fees for new money', link: 'https://c.example/mlp', source: 'FT', vertical: 'hf', date: day(27) },
  { title: 'Blackstone closes $20bn infrastructure fund', link: 'https://d.example/bx', source: 'PR Newswire', vertical: 'pe', date: day(26), dealValue: '$20bn' },
  { title: 'Goldman Sachs reshuffles investment banking leadership', link: 'https://e.example/gs', source: 'WSJ', vertical: 'ib', date: day(25) },
  { title: 'Bank of England holds rates', link: 'https://f.example/boe', source: 'BoE', vertical: 'macro', date: day(24) },
  { title: 'An old story from September', link: 'https://g.example/old', source: 'Reuters', vertical: 'ma', date: '2026-09-01T09:00:00.000Z' },
];
{
  const d = dedupe(items);
  check('normalised titles drop stop words and punctuation', normaliseTitle('Aon to acquire USI, from KKR!') === 'aon acquire usi kkr');
  check('a link is canonical without its query or hash', canonicalLink('https://www.a.example/aon-usi?utm=1') === canonicalLink('https://a.example/aon-usi#top'));
  check('three reports of one story become one item', d.filter((i) => /Aon/.test(i.title)).length === 1);
  const aon = d.find((i) => /Aon/.test(i.title));
  check('the first report is kept and the other source is recorded on it', aon.source === 'Reuters' && aon.alsoReportedBy.includes('Bloomberg'));
  check('items come back newest first', Date.parse(d[0].date) >= Date.parse(d[1].date));
}

/* -------------------------------------------------------- shortlist -- */
{
  const list = shortlist({ news: items, deals: [{ title: 'Deal tape: X buys Y', link: 'https://t.example/xy', source: 'PR Newswire', date: day(27), dealValue: '$850M' }], days: 7 });
  check('the window drops the September story and the merged duplicates count once', list.counts.newsInWindow === 5);
  check('three headline candidates, the most recent first', list.headlines.length === 3 && /Aon/.test(list.headlines[0].item.title) && list.headlines[0].why === 'most recent');
  check('the largest disclosed value is a headline candidate', list.headlines.some((h) => /Blackstone/.test(h.item.title)));
  check('deal candidates never repeat a headline', !list.deals.some((p) => list.headlines.some((h) => h.item.link === p.item.link)));
  check('the first deal candidate carries a disclosed value', list.deals[0] && list.deals[0].item.value);
  check('market moves are one per area, none already offered', list.moves.length >= 2 && !list.moves.some((m) => list.headlines.concat(list.deals).some((p) => p.item.link === m.item.link)));
  const again = shortlist({ news: [...items].reverse(), deals: [], days: 7 });
  check('the shortlist is deterministic whatever the feed order', JSON.stringify(again.headlines.map((h) => h.item.link)) === JSON.stringify(shortlist({ news: items, deals: [], days: 7 }).headlines.map((h) => h.item.link)));
  const sources = sourcesOf(list);
  check('sources are distinct, indexed from zero and capped', sources.every((s, i) => s.index === i) && new Set(sources.map((s) => canonicalLink(s.url))).size === sources.length && sources.length <= 10);
}

/* --------------------------------------------------------- the text -- */
{
  const t = extractText('<html><head><title>Aon buys USI</title><meta name="description" content="A $17bn deal"></head><body><nav>menu</nav><script>x()</script><p>Aon agreed to buy USI for $17bn, the companies said.</p><footer>f</footer></body></html>');
  check('text extraction keeps the title, the description and the body, and drops scripts, nav and footer', t.title === 'Aon buys USI' && t.description === 'A $17bn deal' && /Aon agreed/.test(t.text) && !/menu|x\(\)|^f$/.test(t.text));
  const paths = allowedPaths('<urlset><url><loc>https://www.l3vlup.com/guides/a</loc></url><url><loc>https://www.l3vlup.com/tracker/some-role</loc></url><url><loc>https://www.l3vlup.com/models/merger-model</loc></url><url><loc>https://www.l3vlup.com/dashboard</loc></url></urlset>');
  check('allowed paths are the durable pages, never a tracker role or the dashboard', JSON.stringify(paths) === JSON.stringify(['/guides/a', '/models/merger-model']));
}
check('the week ending is the coming Friday', weekEndingFor(new Date('2026-10-29T06:30:00Z')) === '2026-10-30' && weekEndingFor(new Date('2026-10-30T12:00:00Z')) === '2026-10-30' && weekEndingFor(new Date('2026-10-31T12:00:00Z')) === '2026-11-06');

/* --------------------------------------------------------- assembly -- */
const sources = [
  { index: 0, url: 'https://a.example/aon-usi', name: 'Reuters', date: '2026-10-28', title: 'Aon', area: 'M&A' },
  { index: 1, url: 'https://d.example/bx', name: 'PR Newswire', date: '2026-10-26', title: 'BX', area: 'Private equity' },
  { index: 2, url: 'https://f.example/boe', name: 'BoE', date: '2026-10-24', title: 'BoE', area: 'Macro' },
];
const paths = ['/guides/a', '/models/merger-model'];
const good = {
  headline: { title: 'Aon agrees to buy USI from KKR for $17bn', summary: 'Aon agreed to buy USI from KKR for $17bn. The price is 14 times USI’s earnings, the companies said.', whatHappened: 'Aon agreed to buy USI from KKR for $17bn.', whyItMatters: 'Insurance broking consolidates.', secondOrder: 'KKR returns capital to its 2016 fund.', sourceIndex: 0, companies: ['Aon', 'USI', 'KKR'], relatedPathIndexes: [1, 7] },
  deal: { target: 'USI', acquirer: 'Aon', value: '$17bn', sector: 'Insurance broking', metrics: [{ label: 'Price', value: '$17bn', sourceIndex: 0 }], advisers: [], whyInstructive: 'A sponsor exit to a strategic. The price is stated.', sourceIndex: 0, relatedPathIndexes: [0] },
  marketInFive: [{ title: 'The Bank of England held rates', implication: 'Rates desks price a longer hold.', sourceIndex: 2 }, { title: 'Blackstone closed a $20bn fund', implication: 'More dry powder for infrastructure.', sourceIndex: 1 }],
  prediction: { kind: 'forecast', question: 'Does the deal close by year end?', options: ['Yes', 'No'], resolvesAt: '2026-12-31', resolutionCriteria: 'A completion announcement.', resolutionSourceIndex: 0 },
  cartoon: { scene: 'Lev holds an umbrella over a tiny model of a building.', caption: 'Insured, reinsured, and now acquired.', groundedIn: 'Aon buying USI.' },
};
{
  const { edition, cartoon, problems } = assembleEdition(good, { weekEnding: '2026-10-30', sources, paths });
  check('every URL in the edition comes from the sources list', edition.headline.sourceUrl === sources[0].url && edition.deal.metrics[0].source === sources[0].url && edition.marketInFive[0].sourceUrl === sources[2].url && edition.prediction.resolutionSourceUrl === sources[0].url);
  check('a path index outside the allowed list is dropped and reported, the rest kept', JSON.stringify(edition.headline.relatedLinks) === JSON.stringify(['/models/merger-model']) && problems.some((p) => p.field === 'headline.relatedLinks'));
  check('dates come from the sources, the status is draft and the outcome is null', edition.headline.publishedAt === '2026-10-28' && edition.deal.announcedAt === '2026-10-28' && edition.status === 'draft' && edition.prediction.outcome === null);
  check('the cartoon brief is carried beside the edition, never inside it', cartoon.caption.length > 0 && !('cartoon' in edition));
  const onlyPathProblem = problems.filter((p) => p.field !== 'headline.relatedLinks');
  check('a well-formed draft has no other problem', onlyPathProblem.length === 0, JSON.stringify(onlyPathProblem));
}
{
  const bad = JSON.parse(JSON.stringify(good));
  bad.headline.title = 'Aon will buy USI';
  bad.headline.sourceIndex = 9;
  bad.marketInFive = Array.from({ length: 7 }, () => bad.marketInFive[0]);
  bad.prediction.resolvesAt = '2026-10-29';
  bad.prediction.options = ['Yes', 'Yes'];
  const { edition, problems } = assembleEdition(bad, { weekEnding: '2026-10-30', sources, paths });
  const fields = problems.map((p) => p.field);
  check('a forecasting title is refused', fields.includes('headline.title'));
  check('an invented source index is a problem, not a URL', fields.includes('headline.sourceUrl') && edition.headline.sourceUrl === '');
  check('more than five moves are cut to five', edition.marketInFive.length === 5);
  check('a prediction that resolves before the week ends, or with repeated options, is refused', fields.includes('prediction.resolvesAt') && fields.includes('prediction.options'));
  check('FORECAST catches the usual verbs and not the past tense', FORECAST.test('is set to rise') && FORECAST.test('could fall') && !FORECAST.test('rose by 3% on Tuesday'));
  check('validateDraft on the good edition finds nothing', validateDraft(assembleEdition(good, { weekEnding: '2026-10-30', sources, paths }).edition).length === 0);
}

/* ------------------------------------------------------ model answer -- */
{
  const ok = { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: EDITION_TOOL.name, input: good }] };
  check('one tool call is read back as its input', readDraft(ok) === good);
  const thrown = (r) => { try { readDraft(r); return null; } catch (e) { return e instanceof DraftModelError ? e.reason : 'other'; } };
  check('a refusal, a truncation, two tool calls and no tool call are each a named failure', thrown({ stop_reason: 'refusal', content: [] }) === 'refused' && thrown({ stop_reason: 'max_tokens', content: [] }) === 'truncated' && thrown({ stop_reason: 'tool_use', content: [ok.content[0], ok.content[0]] }) === 'malformed_response' && thrown({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }] }) === 'malformed_response');
  check('the tool is strict and names every section', EDITION_TOOL.strict === true && JSON.stringify(EDITION_TOOL.input_schema.required) === JSON.stringify(['headline', 'deal', 'marketInFive', 'prediction', 'cartoon']));
}

/* ----------------------------------------------------------- budget -- */
{
  const pricing = { inputPerMTok: 2, outputPerMTok: 10 };
  check('a call inside the budget is allowed with its estimate', checkDraftBudget({ budgetUsd: 0.5, pricing, inputTokens: 20_000, outputTokens: 6_000 }).allowed === true);
  check('a budget over the hard stop is refused', checkDraftBudget({ budgetUsd: 5, pricing, inputTokens: 1, outputTokens: 1 }).allowed === false && HARD_STOP_USD === 1);
  check('an unpriced model is refused rather than assumed free', checkDraftBudget({ budgetUsd: 0.5, pricing: undefined, inputTokens: 1, outputTokens: 1 }).allowed === false);
  check('a call that would exceed the budget is refused before it is made', checkDraftBudget({ budgetUsd: 0.05, pricing, inputTokens: 20_000, outputTokens: 6_000 }).allowed === false);
  check('no budget is refused', checkDraftBudget({ budgetUsd: NaN, pricing, inputTokens: 1, outputTokens: 1 }).allowed === false);
}

/* ----------------------------------------------------------- report -- */
{
  const list = shortlist({ news: items, deals: [], days: 7 });
  const draft = { generatedAt: '2026-10-29T06:40:00Z', weekEnding: '2026-10-30', status: 'draft', modelStage: 'failed', failure: 'not_authenticated: the exchange was refused', cost: { budgetUsd: 0.5, estimatedUsd: 0.07, actualUsd: null, model: 'claude-sonnet-5' }, shortlist: list, sources: sourcesOf(list), edition: null, cartoon: null, problems: [] };
  const md = renderReport(draft);
  check('a failed model stage is reported as a failure with the shortlist still present', /Model stage: \*\*failed\*\*/.test(md) && /Headline candidates/.test(md) && /Aon/.test(md));
  check('the report says what a person must do before anything is published', /approved/.test(md) && /npm test -- this-week/.test(md));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
