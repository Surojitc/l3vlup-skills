// The CUSIP-to-ticker map accumulates.
//
// It is read from the SEC's fails-to-deliver files, twelve half-months at a
// time, and a CUSIP appears there only while it is traded. A security that
// changed CUSIP (a reverse split, a reorganisation) stops appearing under the
// old one, so a map rebuilt from the window alone forgets it, and every 13F
// quarter that named the old CUSIP loses its ticker. The refresh of
// 7 November 2026 forgot 449 that way; Piper Sandler's ownership history fell
// from 26 quarters to 2 and agilon's from 18 to 1.
//
// So the window writes over what is known and never removes it: a CUSIP the
// window still sees takes the symbol it trades under now, and one it no
// longer sees keeps the last symbol it was seen with.

/** The previous map's tickers and funds under this run's fresh reading. */
export function mergeTickers(previous, fresh) {
  const prevTickers = previous && typeof previous.tickers === 'object' && previous.tickers ? previous.tickers : {};
  const tickers = { ...prevTickers, ...fresh.tickers };
  const funds = new Set([...(Array.isArray(previous?.funds) ? previous.funds : []), ...fresh.funds]);
  const kept = Object.keys(prevTickers).filter((c) => !(c in fresh.tickers)).length;
  return { tickers, funds, kept };
}
