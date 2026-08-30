#!/usr/bin/env node
// Daily auto-post — composes one post from the day's real data and sends it to
// whichever channels have credentials configured. Every channel is optional and
// skipped silently when its secrets are absent, so the job never fails on a
// missing key. Run with --dry to compose and print without sending.
//
// Channels, in order of how easy they are to switch on:
//   Discord   DISCORD_WEBHOOK_URL                   (webhook, no approval)
//   Slack     SLACK_WEBHOOK_URL                     (webhook, no approval)
//   Telegram  TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (bot, no approval)
//   Bluesky   BLUESKY_HANDLE + BLUESKY_APP_PASSWORD (free API, no approval)
//   X         X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
//
// Nothing here invents a number: every figure comes from the committed data
// files the other sync jobs produce.

import { readFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const SITE = 'https://www.l3vlup.com';

const readJson = (rel) => {
  try {
    return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
  } catch {
    return null;
  }
};

const today = new Date().toISOString().slice(0, 10);
const fmtDay = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

// --- Candidate posts, best first -------------------------------------------

/** A market-moving release lands today or tomorrow. */
function calendarPost() {
  const cal = readJson('data/calendar.auto.json');
  if (!cal?.events?.length) return null;
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const hit = cal.events.find((e) => e.importance === 'high' && (e.date === today || e.date === tomorrow));
  if (!hit) return null;

  const macro = readJson('data/macro.auto.json');
  const series = macro?.series ?? [];
  const cpi = series.find((s) => s.id === 'us-cpi-yoy');
  const ten = series.find((s) => s.id === 'us-treasury-10y');
  const last = (s) => (s?.points?.length ? s.points[s.points.length - 1].v : null);

  const when = hit.date === today ? 'today' : 'tomorrow';
  const context = [];
  if (/consumer price|inflation/i.test(hit.title) && last(cpi) !== null) {
    context.push(`CPI last printed ${last(cpi)}% year on year.`);
  }
  if (last(ten) !== null) context.push(`The 10-year sits at ${last(ten)}%.`);

  return {
    kind: 'calendar',
    text: [
      `📅 ${hit.title} lands ${when}${hit.time ? ` at ${hit.time} ${hit.tz ?? ''}`.trimEnd() : ''}.`,
      context.join(' '),
      'Know the number before someone asks you for it.',
    ]
      .filter(Boolean)
      .join('\n\n'),
    url: `${SITE}/macro/calendar`,
    tags: ['macro', 'finance'],
  };
}

/** The largest disclosed deal on the tape in the last two days. */
function dealPost() {
  const deals = readJson('data/deals.auto.json');
  if (!deals?.items?.length) return null;
  const cutoff = new Date(Date.now() - 2 * 86400000).toISOString();
  const parse = (v) => {
    const m = /^([$£€])([\d.]+)([MB])$/.exec(v ?? '');
    if (!m) return 0;
    return parseFloat(m[2]) * (m[3] === 'B' ? 1000 : 1);
  };
  const recent = deals.items.filter((d) => d.dealValue && (d.date ?? '') >= cutoff);
  if (!recent.length) return null;
  const top = recent.sort((a, b) => parse(b.dealValue) - parse(a.dealValue))[0];
  const headline = top.title.length > 110 ? `${top.title.slice(0, 107).trimEnd()}…` : top.title;

  return {
    kind: 'deal',
    text: [
      `🤝 ${top.dealValue} on the tape: ${headline}`,
      '"Walk me through a recent deal" is the most predictable question in finance. Here is one, with the mechanics behind it.',
    ].join('\n\n'),
    url: `${SITE}/pulse`,
    tags: ['MandA', 'privateequity'],
  };
}

/** The everyday fallback: today's puzzle. */
function puzzlePost() {
  // Read the epoch straight out of lib/daily-games so the puzzle number in the
  // post always matches the number on the site, even if the epoch ever moves.
  // This repo has no lib/daily-games.ts (that is the site's source tree), so
  // the epoch is pinned here. It MUST match EPOCH_UTC in the site's
  // lib/daily-games.ts or the puzzle number in the post drifts from the one
  // on the page: Date.UTC(2026, 7, 19) = 19 Aug 2026.
  const epoch = Date.UTC(2026, 7, 19);
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = Math.max(1, Math.floor((todayUtc - epoch) / 86400000) + 1);
  const rotation = [
    { emoji: '🟩', name: 'Correlated', path: '/games/correlated', line: 'Group 16 finance terms into 4 baskets before risk pulls your book.' },
    { emoji: '🎯', name: 'Ticker', path: '/games/ticker', line: 'Six guesses to find the ticker. Green means right letter, right slot.' },
    { emoji: '🧾', name: 'Reconcile', path: '/games/reconcile', line: 'Balance the grid. Accounting as a logic puzzle.' },
    { emoji: '📉', name: 'The Tape', path: '/games/the-tape', line: 'Five real market moments. Call which way each one went.' },
  ];
  const g = rotation[day % rotation.length];
  return {
    kind: 'puzzle',
    text: [`${g.emoji} ${g.name} #${day} is live.`, g.line, 'One puzzle a day, the same for everyone.'].join('\n\n'),
    url: `${SITE}${g.path}`,
    tags: ['finance', 'dailygame'],
  };
}

function compose() {
  return calendarPost() ?? dealPost() ?? puzzlePost();
}

// --- Channels ----------------------------------------------------------------

async function postDiscord(post, body) {
  const hook = process.env.DISCORD_WEBHOOK_URL;
  if (!hook) return 'skipped (no DISCORD_WEBHOOK_URL)';
  const res = await fetch(hook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: body }),
  });
  return res.ok ? 'posted' : `HTTP ${res.status}`;
}

async function postSlack(post, body) {
  const hook = process.env.SLACK_WEBHOOK_URL;
  if (!hook) return 'skipped (no SLACK_WEBHOOK_URL)';
  const res = await fetch(hook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: body }),
  });
  return res.ok ? 'posted' : `HTTP ${res.status}`;
}

async function postTelegram(post, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return 'skipped (no TELEGRAM_BOT_TOKEN/CHAT_ID)';
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: body, disable_web_page_preview: false }),
  });
  return res.ok ? 'posted' : `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
}

async function postBluesky(post, body) {
  const handle = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;
  if (!handle || !password) return 'skipped (no BLUESKY_HANDLE/APP_PASSWORD)';

  const auth = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: handle, password }),
  });
  if (!auth.ok) return `auth HTTP ${auth.status}`;
  const { accessJwt, did } = await auth.json();

  // Link the URL so it renders as a clickable facet rather than plain text.
  const bytes = Buffer.from(body, 'utf8');
  const start = bytes.indexOf(Buffer.from(post.url, 'utf8'));
  const facets =
    start >= 0
      ? [
          {
            index: { byteStart: start, byteEnd: start + Buffer.byteLength(post.url) },
            features: [{ $type: 'app.bsky.richtext.facet#link', uri: post.url }],
          },
        ]
      : [];

  const res = await fetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessJwt}` },
    body: JSON.stringify({
      repo: did,
      collection: 'app.bsky.feed.post',
      record: { $type: 'app.bsky.feed.post', text: body, facets, createdAt: new Date().toISOString() },
    }),
  });
  return res.ok ? 'posted' : `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
}

/** OAuth 1.0a signing — what X's POST /2/tweets wants from a CI job. */
function oauthHeader(url, method, consumerKey, consumerSecret, token, tokenSecret) {
  const params = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: token,
    oauth_version: '1.0',
  };
  const enc = (v) => encodeURIComponent(v).replace(/[!*()']/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const paramString = Object.keys(params)
    .sort()
    .map((k) => `${enc(k)}=${enc(params[k])}`)
    .join('&');
  const base = [method.toUpperCase(), enc(url), enc(paramString)].join('&');
  const signingKey = `${enc(consumerSecret)}&${enc(tokenSecret)}`;
  const signature = createHmac('sha1', signingKey).update(base).digest('base64');
  const all = { ...params, oauth_signature: signature };
  return (
    'OAuth ' +
    Object.keys(all)
      .sort()
      .map((k) => `${enc(k)}="${enc(all[k])}"`)
      .join(', ')
  );
}

async function postX(post, body) {
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
  if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) {
    return 'skipped (no X_* credentials)';
  }
  const url = 'https://api.twitter.com/2/tweets';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: oauthHeader(url, 'POST', X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: body }),
  });
  return res.ok ? 'posted' : `HTTP ${res.status}: ${(await res.text()).slice(0, 250)}`;
}

// --- Run ----------------------------------------------------------------------

const post = compose();
if (!post) {
  console.log('Nothing to post today.');
  process.exit(0);
}
const hashtags = post.tags.map((t) => `#${t}`).join(' ');

// X counts every URL as 23 characters however long it is. Budget backwards from
// 280 and trim the body at a sentence or word boundary rather than mid-word.
const X_LIMIT = 280;
function fitForX(text) {
  const budget = X_LIMIT - 23 - hashtags.length - 3; // url + two newlines + a space
  if (text.length <= budget) return text;
  const cut = text.slice(0, budget - 1);
  const at = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return `${cut.slice(0, at > budget * 0.5 ? at : cut.length).trimEnd()}…`;
}

const short = `${fitForX(post.text)}\n\n${post.url}\n${hashtags}`;
const long = `${post.text}\n\n${post.url}`;
const xLength = fitForX(post.text).length + 23 + hashtags.length + 3;

console.log(`Composed a "${post.kind}" post for ${fmtDay(today)}:\n`);
console.log('─'.repeat(60));
console.log(short);
console.log('─'.repeat(60));
console.log(`\nLength for X: ${xLength}/280 chars${xLength > X_LIMIT ? '  ⚠️ OVER' : ''}\n`);

if (DRY) {
  console.log('Dry run — nothing sent.');
  process.exit(0);
}

const results = await Promise.all([
  postDiscord(post, long).then((r) => ['Discord', r]),
  postSlack(post, long).then((r) => ['Slack', r]),
  postTelegram(post, long).then((r) => ['Telegram', r]),
  postBluesky(post, short).then((r) => ['Bluesky', r]),
  postX(post, short).then((r) => ['X', r]),
]);

let failed = false;
for (const [name, result] of results) {
  console.log(`${name.padEnd(9)} ${result}`);
  if (!/^posted|^skipped/.test(result)) failed = true;
}

if (results.every(([, r]) => r.startsWith('skipped'))) {
  console.log('\nNo channels configured yet — see REMAINING_ACTIONS.md for the five-minute setup.');
}
process.exit(failed ? 1 : 0);
