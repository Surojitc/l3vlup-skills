// The CUSIP map only accumulates: lib/cusip-tickers.mjs.
import { mergeTickers } from '../../lib/cusip-tickers.mjs';

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${JSON.stringify(detail)}`}`);
  if (!ok) failed += 1;
};

const previous = { tickers: { '724078100': 'PIPR', '00857U107': 'AGL', '111111111': 'OLD' }, funds: ['SPY'] };
const fresh = { tickers: { '724078209': 'PIPR', '00857U206': 'AGL', '111111111': 'NEW' }, funds: new Set(['QQQ']) };
const m = mergeTickers(previous, fresh);
check('a CUSIP the window no longer sees keeps its last symbol', m.tickers['724078100'] === 'PIPR' && m.tickers['00857U107'] === 'AGL', m.tickers);
check('a CUSIP the window sees takes the symbol it trades under now', m.tickers['111111111'] === 'NEW');
check('new CUSIPs are added', m.tickers['724078209'] === 'PIPR' && m.tickers['00857U206'] === 'AGL');
check('kept counts only the CUSIPs the window did not see', m.kept === 2, m.kept);
check('funds accumulate', m.funds.has('SPY') && m.funds.has('QQQ'));
const cold = mergeTickers(null, fresh);
check('no previous map: the window alone', Object.keys(cold.tickers).length === 3 && cold.kept === 0);
const broken = mergeTickers({ tickers: null, funds: 'x' }, fresh);
check('an unreadable previous map is ignored, not trusted', Object.keys(broken.tickers).length === 3 && broken.funds.size === 1);

console.log(`\n${7 - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
