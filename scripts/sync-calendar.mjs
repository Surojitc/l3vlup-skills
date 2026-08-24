#!/usr/bin/env node
// Economic calendar sync — forward-looking release schedules from the agencies
// themselves. ICS where they publish one (BLS, BEA, Eurostat), RSS where they
// don't (ONS), and a narrow HTML date parse for the two that publish no feed at
// all (FOMC, Bank of England MPC). No aggregators, no keys, no paid feeds.
//
// Runs in GitHub Actions (open internet); /macro/calendar renders from the
// committed JSON. One failing source never wipes the others.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = { 'User-Agent': 'L3VLUP-calendar/1.0 (educational; contact: suro@l3vlup.com)' };
const HORIZON_DAYS = 120;

const today = new Date().toISOString().slice(0, 10);
const horizon = new Date(Date.now() + HORIZON_DAYS * 86400000).toISOString().slice(0, 10);

async function fetchText(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Releases that actually move a screen. Everything else is context.
const HIGH_IMPACT =
  /consumer price index|employment situation|nonfarm|payroll|gross domestic product|\bgdp\b|personal income and outlays|\bpce\b|retail sales|producer price|fomc|federal open market|monetary policy|interest rate|bank rate|inflation|unemployment|labour market|labor market/i;

const importanceOf = (title) => (HIGH_IMPACT.test(title) ? 'high' : 'medium');

// --- ICS ---------------------------------------------------------------------

/** Minimal iCalendar parse: unfold continuation lines, then read VEVENTs. */
function parseIcs(ics) {
  const unfolded = ics.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const events = [];
  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0];
    const get = (key) => {
      const m = new RegExp(`^${key}[^:\\r\\n]*:(.*)$`, 'm').exec(body);
      return m ? m[1].trim() : null;
    };
    const summary = get('SUMMARY');
    const dtstart = get('DTSTART');
    if (!summary || !dtstart) continue;
    // DTSTART is either YYYYMMDD or YYYYMMDDTHHMMSS(Z)
    const dm = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/.exec(dtstart);
    if (!dm) continue;
    events.push({
      date: `${dm[1]}-${dm[2]}-${dm[3]}`,
      time: dm[4] ? `${dm[4]}:${dm[5]}` : null,
      title: summary.replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\s+/g, ' ').trim(),
    });
  }
  return events;
}

async function icsSource({ url, country, source, link, tz }) {
  const events = parseIcs(await fetchText(url));
  return events.map((e) => ({
    date: e.date,
    time: e.time,
    tz: e.time ? tz : null,
    country,
    title: e.title,
    source,
    url: link,
    importance: importanceOf(e.title),
  }));
}

// --- RSS ---------------------------------------------------------------------

const stripTags = (s) =>
  s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

const ONS_RELEASES = [
  'Consumer price inflation',
  'Labour market overview',
  'GDP monthly estimate',
  'Retail sales',
  'Producer price inflation',
  'Average weekly earnings',
];

async function onsCalendar() {
  // The generic upcoming feed is dominated by niche statistical outputs, so ask
  // the release calendar for the releases a markets audience actually watches.
  const out = [];
  for (const q of ONS_RELEASES) {
    let xml;
    try {
      xml = await fetchText(
        `https://www.ons.gov.uk/releasecalendar?rss&release-type=type-upcoming&query=${encodeURIComponent(q)}`
      );
    } catch (err) {
      console.log(`    ONS "${q}": ${err.message}`);
      continue;
    }
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const block = m[1];
      const pick = (tag) => {
        const mm = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
        return mm ? stripTags(mm[1]) : null;
      };
      const title = pick('title');
      const pubDate = pick('pubDate');
      const link = pick('link');
      if (!title || !pubDate) continue;
      const d = new Date(pubDate);
      if (Number.isNaN(d.getTime())) continue;
      out.push({
        date: d.toISOString().slice(0, 10),
        time: '07:00',
        tz: 'GMT',
        country: 'UK',
        title,
        source: 'Office for National Statistics',
        url: link ?? 'https://www.ons.gov.uk/releasecalendar',
        importance: importanceOf(title),
      });
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return out;
}

// --- HTML (no feed published) ------------------------------------------------

const MONTHS = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};

async function fomcDates() {
  // The Fed publishes no ICS/JSON for the FOMC calendar, so read the schedule
  // page it does publish. Meetings render as a month label plus a day range.
  const html = await fetchText('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm');
  const out = [];
  const yearRe = /(20\d\d)\s+FOMC\s+Meetings/gi;
  const years = Array.from(html.matchAll(yearRe), (m) => ({ year: m[1], at: m.index ?? 0 }));
  const monthRe = /fomc-meeting__month[^>]*>\s*(?:<[^>]+>\s*)*([A-Za-z]+)/g;
  const dateRe = /fomc-meeting__date[^>]*>\s*(?:<[^>]+>\s*)*([\d\-–*\s]+)/g;
  const months = Array.from(html.matchAll(monthRe), (m) => ({ v: m[1], at: m.index ?? 0 }));
  const dates = Array.from(html.matchAll(dateRe), (m) => ({ v: m[1], at: m.index ?? 0 }));
  for (let i = 0; i < Math.min(months.length, dates.length); i++) {
    const monthName = months[i].v.toLowerCase().split('/')[0];
    const mm = MONTHS[monthName];
    if (!mm) continue;
    // Last day of the range is decision day (statement + press conference).
    const days = dates[i].v.match(/\d{1,2}/g);
    if (!days) continue;
    const dd = days[days.length - 1].padStart(2, '0');
    const year = years.filter((y) => y.at < months[i].at).pop()?.year
      ?? String(new Date().getUTCFullYear());
    out.push({
      date: `${year}-${mm}-${dd}`,
      time: '14:00',
      tz: 'ET',
      country: 'US',
      title: 'FOMC rate decision and statement',
      source: 'Federal Reserve',
      url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
      importance: 'high',
    });
  }
  return out;
}

async function boeMpcDates() {
  // Likewise no feed: the BoE publishes MPC announcement dates as a page of
  // "Thursday 5 February 2026" strings, a year or two ahead.
  const html = await fetchText('https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates');
  return datesIn(html).map((date) => ({
    date,
    time: '12:00',
    tz: 'GMT',
    country: 'UK',
    title: 'Bank of England Bank Rate announcement (MPC)',
    source: 'Bank of England',
    url: 'https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates',
    importance: 'high',
  }));
}

/** Every "5 February 2026" / "February 5, 2026" date in a page, as ISO strings. */
function datesIn(html) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const M = '(January|February|March|April|May|June|July|August|September|October|November|December)';
  const out = [];
  for (const m of text.matchAll(new RegExp(`(\\d{1,2})\\s+${M}\\s+(20\\d\\d)`, 'gi'))) {
    out.push({ date: `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}`, at: m.index ?? 0, len: m[0].length });
  }
  for (const m of text.matchAll(new RegExp(`${M}\\s+(\\d{1,2}),\\s*(20\\d\\d)`, 'gi'))) {
    out.push({ date: `${m[3]}-${MONTHS[m[1].toLowerCase()]}-${m[2].padStart(2, '0')}`, at: m.index ?? 0, len: m[0].length });
  }
  return out.map((o) => o.date);
}

/** Dates plus the surrounding text, for pages that list dates against release names. */
function datedEntriesIn(html, window = 110) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const M = '(January|February|March|April|May|June|July|August|September|October|November|December)';
  const out = [];
  for (const m of text.matchAll(new RegExp(`${M}\\s+(\\d{1,2}),\\s*(20\\d\\d)`, 'gi'))) {
    const at = (m.index ?? 0) + m[0].length;
    out.push({
      date: `${m[3]}-${MONTHS[m[1].toLowerCase()]}-${m[2].padStart(2, '0')}`,
      after: text.slice(at, at + window).trim(),
      near: text.slice(Math.max(0, (m.index ?? 0) - window), at + window).trim(),
    });
  }
  for (const m of text.matchAll(new RegExp(`(\\d{1,2})\\s+${M}\\s+(20\\d\\d)`, 'gi'))) {
    const at = (m.index ?? 0) + m[0].length;
    out.push({
      date: `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}`,
      after: text.slice(at, at + window).trim(),
      near: text.slice(Math.max(0, (m.index ?? 0) - window), at + window).trim(),
    });
  }
  return out;
}

// BEA publishes an ICS link that returns no VEVENTs, so read the schedule page
// it renders for humans and keep the headline national-accounts releases.
const BEA_RELEASES = [
  'Gross Domestic Product',
  'Personal Income and Outlays',
  'International Trade in Goods and Services',
  'Corporate Profits',
  'GDP by Industry',
  'Personal Income by State',
  'International Transactions',
];

async function beaSchedule() {
  const html = await fetchText('https://www.bea.gov/news/schedule');
  const out = [];
  for (const e of datedEntriesIn(html, 140)) {
    const hit = BEA_RELEASES.find((r) => e.near.toLowerCase().includes(r.toLowerCase()));
    if (!hit) continue;
    const t = /(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)/i.exec(e.after);
    let time = null;
    if (t) {
      let h = Number(t[1]) % 12;
      if (/p/i.test(t[3])) h += 12;
      time = `${String(h).padStart(2, '0')}:${t[2]}`;
    }
    out.push({
      date: e.date,
      time,
      tz: time ? 'ET' : null,
      country: 'US',
      title: hit,
      source: 'Bureau of Economic Analysis',
      url: 'https://www.bea.gov/news/schedule',
      importance: 'high',
    });
  }
  return out;
}

// The ECB publishes no structured feed for Governing Council dates either.
async function ecbGoverningCouncil() {
  const html = await fetchText('https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html');
  const out = [];
  for (const e of datedEntriesIn(html, 90)) {
    if (!/monetary policy meeting/i.test(e.near)) continue;
    out.push({
      date: e.date,
      time: '14:15',
      tz: 'CET',
      country: 'Eurozone',
      title: 'ECB Governing Council monetary policy decision',
      source: 'European Central Bank',
      url: 'https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html',
      importance: 'high',
    });
  }
  return out;
}

// --- Sources -----------------------------------------------------------------

const SOURCES = [
  {
    name: 'BLS release schedule (ICS)',
    fetch: () =>
      icsSource({
        url: 'https://www.bls.gov/schedule/news_release/bls.ics',
        country: 'US',
        source: 'Bureau of Labor Statistics',
        link: 'https://www.bls.gov/schedule/news_release/',
        tz: 'ET',
      }),
  },
  { name: 'BEA release schedule (HTML)', fetch: beaSchedule },
  { name: 'FOMC meeting dates (HTML)', fetch: fomcDates },
  { name: 'ECB Governing Council dates (HTML)', fetch: ecbGoverningCouncil },
  { name: 'ONS release calendar (RSS)', fetch: onsCalendar },
  { name: 'Bank of England MPC dates (HTML)', fetch: boeMpcDates },
];

// --- Run ---------------------------------------------------------------------

let events = [];
for (const s of SOURCES) {
  process.stdout.write(`Fetching ${s.name}… `);
  try {
    const got = await s.fetch();
    const inWindow = got.filter((e) => e.date >= today && e.date <= horizon);
    console.log(`${got.length} parsed, ${inWindow.length} in the next ${HORIZON_DAYS} days`);
    events.push(...inWindow);
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 800));
}

if (events.length === 0) {
  console.error('No events fetched — leaving existing calendar untouched.');
  process.exit(1);
}

// The statistical agencies publish a long tail of niche releases. Keep the ones
// a finance candidate could plausibly be asked about; drop the rest.
const RELEVANT =
  /consumer price|producer price|inflation|employment situation|nonfarm|payroll|unemployment|jobless|labour market|labor force|job openings|jolts|earnings|wage|gross domestic product|\bgdp\b|personal income|\bpce\b|retail sales|industrial production|productivity|trade in goods|balance of trade|import.{0,12}price|export.{0,12}price|corporate profits|business investment|house price|economic sentiment|money and credit|monetary policy|bank rate|interest rate|fomc/i;
const ALWAYS_KEEP = new Set(['Federal Reserve', 'Bank of England', 'European Central Bank']);
events = events.filter((e) => ALWAYS_KEEP.has(e.source) || RELEVANT.test(e.title));

// Dedupe on date + normalised title, soonest first.
const seen = new Set();
events = events
  .filter((e) => {
    const key = `${e.date}|${e.title.toLowerCase().slice(0, 60)}`;
    return seen.has(key) ? false : (seen.add(key), true);
  })
  .sort((a, b) => (a.date === b.date ? (a.time ?? '').localeCompare(b.time ?? '') : a.date.localeCompare(b.date)));

mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(
  join(ROOT, 'data', 'calendar.auto.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), events })
);

const byCountry = events.reduce((acc, e) => ({ ...acc, [e.country]: (acc[e.country] ?? 0) + 1 }), {});
console.log(`\nWrote ${events.length} events → data/calendar.auto.json`, byCountry);
