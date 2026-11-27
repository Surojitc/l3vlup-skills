#!/usr/bin/env node
/**
 * The tracker's source registry, printed: every board, the method it is read
 * through, whether that method may be read and why, attribution, the last
 * check and the last success, known limitations and announced changes, then
 * the alerts the daily health report raises (lib/source-registry.mjs).
 *
 *   node scripts/source-registry.mjs            Markdown to stdout
 *   node scripts/source-registry.mjs --json     the records and alerts as JSON
 *
 * Reads committed files only; no network, no writes.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { buildSourceRegistry, sourceAlerts } from '../lib/source-registry.mjs';

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const registry = read('lib/sources/ats-registry.json').firms;
const terms = read('lib/sources/source-terms.json');
const checks = readdirSync('data/board-checks').filter((f) => f.endsWith('.json')).sort().slice(-14).map((f) => read(`data/board-checks/${f}`));
const records = buildSourceRegistry(registry, terms, checks);
const alerts = sourceAlerts(records, { today: new Date().toISOString().slice(0, 10) });

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ checked: terms.checked, records: records.map(({ history, ...r }) => r), alerts }, null, 2));
} else {
  const out = ['# Tracker sources', '', `Terms last read ${terms.checked}. ${records.filter((r) => r.active).length} active, ${records.filter((r) => !r.active).length} parked.`, '',
    '| Firm | Method | Permitted | Last check | Last success | Roles | Parked |', '|---|---|---|---|---|---|---|'];
  for (const r of [...records].sort((a, b) => a.firm.localeCompare(b.firm))) {
    out.push(`| ${r.firm} | ${r.ats} | ${r.permitted} | ${r.lastChecked ?? 'never'} ${r.lastStatus ?? ''} | ${r.lastSuccess ?? 'never'} | ${r.roles ?? ''} | ${r.parkedReason ? r.parkedReason.slice(0, 60) : ''} |`);
  }
  out.push('', '## Methods', '');
  for (const [m, t] of Object.entries(terms.methods)) {
    out.push(`- **${m}** (${t.permitted}): ${t.basis}${t.attribution ? ` Attribution: ${t.attribution}` : ''}${t.limitations ? ` Limitations: ${t.limitations}` : ''}${(t.breaking ?? []).map((b) => ` **${b.on}:** ${b.what}`).join('')}`);
  }
  out.push('', '## Not read', '', ...Object.entries(terms.notRead ?? {}).map(([k, v]) => `- **${k}**: ${v}`));
  out.push('', '## Alerts', '', ...(alerts.length ? alerts.map((a) => `- ${a.level === 'problem' ? '🔴' : '🟡'} ${a.kind}: ${a.message}`) : ['None.']));
  console.log(out.join('\n'));
}
