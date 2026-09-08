"""
The database file: what is already on it, what a finished row looks like, and
how it is written back.

Two builders write to one file, so neither of them owns it. A row carries the
form it was read from, and each builder refreshes only its own rows; everything
else on the file passes through untouched. `finalize` runs on every write
rather than only on a fresh read, so a change to the derived figures or to the
sanity checks reaches every row without reading a single filing again.
"""

from __future__ import annotations

import json
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from . import parse

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
#: the take-private index sync-decks.mjs builds and commits
DECKS = DATA / "decks.auto.json"
OUT = DATA / "precedent-transactions.auto.json"


def load_stored() -> dict[str, dict]:
    """Every row already on file, by id, whichever builder wrote it."""
    if not OUT.exists():
        return {}
    try:
        return {r["id"]: r for r in json.loads(OUT.read_text()).get("transactions", [])}
    except Exception:  # noqa: BLE001
        return {}


# ── the sector bucket ────────────────────────────────────────────────────────

_sector_map: dict[str, Counter] | None = None


def _sector_table() -> dict[str, Counter]:
    """SIC prefix to the sector the deck index gives it, by the deals already bucketed there."""
    global _sector_map
    if _sector_map is None:
        table: dict[str, Counter] = {}
        for path in (DECKS, OUT):
            if not path.exists():
                continue
            try:
                deals = json.loads(path.read_text()).get("transactions") or []
            except Exception:  # noqa: BLE001
                continue
            for d in deals:
                sic = str((d.get("target") or {}).get("sic") or "")
                sector = d.get("sector")
                if not sic or not sector:
                    continue
                for n in (4, 3, 2):
                    table.setdefault(sic[:n], Counter())[sector] += 1
        _sector_map = table
    return _sector_map


#: the divisions EDGAR's codes fall in, for an industry no deal has reached yet
_SECTOR_FALLBACK = [
    (("60", "61", "62", "63", "64", "67"), "Financials"),
    (("65",), "Real Estate"),
    (("13", "29", "46", "1311"), "Energy"),
    (("49",), "Utilities"),
    (("48", "27", "78", "79"), "Media & Telecom"),
    (("28", "80", "384", "283"), "Healthcare"),
    (("35", "36", "737", "738"), "Technology"),
    (("10", "12", "14", "26", "30", "32", "33"), "Materials"),
    (("40", "41", "42", "44", "45", "47"), "Industrials"),
    (("87", "73", "82"), "Business Services"),
    (("20", "21", "22", "23", "25", "31", "52", "53", "54", "55", "56", "57", "58", "59", "70", "72"), "Consumer & Retail"),
]


def sector_for_sic(sic: str | None) -> str | None:
    """The sector bucket the deck index would give an industry code, longest prefix first."""
    s = str(sic or "")
    if not s:
        return None
    table = _sector_table()
    for n in (4, 3, 2):
        c = table.get(s[:n])
        if c:
            return c.most_common(1)[0][0]
    for prefixes, sector in _SECTOR_FALLBACK:
        if any(s.startswith(p) for p in prefixes):
            return sector
    return "Other"


# ── the derived figures ──────────────────────────────────────────────────────


def _year_before(iso: str) -> str:
    """The same day a year earlier, for bounding a merger agreement date."""
    try:
        return (date.fromisoformat(iso[:10]) - timedelta(days=400)).isoformat()
    except ValueError:
        return "0000-00-00"


def finalize(row: dict) -> dict:
    """
    The derived fields from the stored reading: the acquirer, the reference
    prices behind the stated premiums, equity and enterprise value, the
    multiples, and the flags. Run on every write, so a change here reaches
    every row without reading the filings again.
    """
    # Where a row parsed its acquirer out of the merger agreement sentence
    # there is no filer list to rank, so the parse stands.
    if not row.get("acquirerBasis"):
        row["acquirer"] = parse.acquirer_of(row.get("buyers") or [], (row.get("target") or {}).get("name"))
    row["acquirer"] = parse.pretty(row.get("acquirer")) or None
    if not row.get("source"):
        row["source"] = "SC 13E3"
    if not row.get("dealType"):
        row["dealType"] = "take-private" if row["source"] == "SC 13E3" else "public merger"
    if row["dealType"] == "public merger":
        # A proxy names no buyer group, so the type is read off the name.
        row["buyerType"] = parse.classify_buyer(row.get("acquirer"))
    flags: list[str] = []
    # What each flag puts in doubt. A stock deal's cash-per-share figure is not
    # the price, so its multiples are unusable, but the premium the filing
    # states is still the premium. A row is rarely wrong in every direction,
    # and discarding all of it loses precedents worth citing.
    doubt: set[str] = set()

    def flag(text: str, puts_in_doubt: str) -> None:
        flags.append(text)
        doubt.add(puts_in_doubt)

    for k in ("unaffectedPrice", "vwap30", "high52", "equityValue", "ev", "evLtmRev", "evLtmEbitda", "dealValueRatio", "doubt"):
        row.pop(k, None)
    offer = row.get("offerPrice")
    if row.get("status") != "ok" or offer is None:
        row["flags"] = flags
        row["doubt"] = sorted(doubt)
        return row
    # Sanity on the reading itself, before anything is derived from it. These
    # are the three ways a parsed figure has actually been wrong: a dollar
    # amount that was never per-share, a clause captured instead of a party,
    # and a proxy in which the filer is the buyer rather than the target.
    # A merger agreement is signed shortly before the proxy goes out, so an
    # agreement date years earlier is a date lifted from somewhere else in the
    # document. Keep the filing date, which is always true, and say so.
    filed, announced = row.get("filed"), row.get("announced")
    if filed and announced and not (filed >= announced >= _year_before(filed)):
        row["announced"] = filed
        row["announcedBasis"] = "filing date"
        row["readErrors"] = (row.get("readErrors") or []) + [f"agreement date {announced} is not within a year of the filing"]
    if offer > 2000:
        flag(f"consideration of ${offer:,.2f} per share: not a per-share figure", "multiples")
        doubt.add("premiums")
    acq = (row.get("acquirer") or "").strip()
    if acq and (parse.is_clause(acq) or parse.same_registrant(acq, (row.get("target") or {}).get("name") or "")):
        if parse.same_registrant(acq, (row.get("target") or {}).get("name") or ""):
            flag("the buyer named in the merger agreement is the filer: an acquirer-side vote", "multiples")
            doubt.add("premiums")
        row["acquirer"] = None
    if row.get("consideration") in ("cash and stock", "stock"):
        flag("consideration includes stock: the cash figure is not the price", "multiples")
    for prem, key in (("premium1Day", "unaffectedPrice"), ("premium30DayVwap", "vwap30"), ("premium52WeekHigh", "high52")):
        if row.get(prem) is not None:
            row[key] = round(offer / (1 + row[prem]), 2)
    if row.get("premium1Day") is not None and row["premium1Day"] > 1.5:
        flag(f"premium of {row['premium1Day']:.0%}: distressed or misread", "premiums")
    shares = row.get("sharesOut")
    if shares:
        row["equityValue"] = round(offer * shares, 1)
        row["ev"] = round(row["equityValue"] + (row.get("netDebt") or 0.0), 1)
        if row.get("netDebt") is None:
            flag("no balance sheet at announcement: EV = equity value", "multiples")
        rev, ebitda = row.get("ltmRevenue"), row.get("ltmEbitda")
        if rev and rev > 0:
            row["evLtmRev"] = round(row["ev"] / rev, 2)
        if ebitda and ebitda > 0:
            row["evLtmEbitda"] = round(row["ev"] / ebitda, 2)
    # Cross-checks. The fee-table value is the aggregate the filer computed,
    # so an equity value well below it means the price or the share count was
    # misread; well above it is a minority buyout, where the fee is on the
    # shares bought, and is fine within reason.
    dv, eq = row.get("dealValue"), row.get("equityValue")
    if dv and eq:
        ratio = eq / dv
        row["dealValueRatio"] = round(ratio, 2)
        if ratio < 0.5 or ratio > 12:
            flag(f"equity value {eq:,.0f} vs fee-table value {dv:,.0f}", "multiples")
    if row.get("evLtmEbitda") is not None and not 1.0 <= row["evLtmEbitda"] <= 75:
        flag(f"EV / LTM EBITDA {row['evLtmEbitda']:.1f}x outside 1x to 75x", "multiples")
    if row.get("evLtmRev") is not None and row["evLtmRev"] > 60:
        flag(f"EV / LTM revenue {row['evLtmRev']:.1f}x above 60x", "multiples")
    row["flags"] = flags
    row["doubt"] = sorted(doubt)
    return row


def line(row: dict) -> str:
    """One row as the run log prints it."""
    name = parse.pretty(row["target"]["name"])[:30]
    if row["status"] != "ok":
        return f"{name:<30} {row['announced']}  {row['status']}" + (f": {row.get('error', '')}" if row.get("error") else "")
    offer = f"${row['offerPrice']:,.2f}"
    mult = f"{row['evLtmEbitda']:.1f}x EBITDA" if row.get("evLtmEbitda") is not None else ("n.a. EBITDA" if row.get("ltmEbitda") is None else "neg. EBITDA")
    prem = f"{row['premium1Day']:.0%} premium" if row.get("premium1Day") is not None else "no premium stated"
    flag = "  [check]" if row.get("flags") else ""
    return f"{name:<30} {row['announced']}  {offer:>9}  {mult:<14} {prem}{flag}"


# ── writing ──────────────────────────────────────────────────────────────────

METHOD = {
    "source": "SEC EDGAR: Schedule 13E-3 transaction statements and the proxy statements attached to or filed with them (dealType take-private), and DEFM14A / DEFM14C definitive merger proxies found through the quarterly form index (dealType public merger); XBRL company facts for the target's financials",
    "acquirer": "for a take-private, the buyer a page names from the 13E-3 filer list; for a merger proxy, the first named party of the merger agreement sentence that is neither the target nor a merger vehicle (acquirerBasis is the sentence), null where the parties are named only by defined term",
    "status": "ok, no-offer (read, no per-share cash figure stated), no-consideration (an acquirer-side vote: the filer's own holders voted on issuing shares), rejected (a blank-check shell or a fund reorganisation, not a precedent transaction) or error",
    "announced": "the merger agreement date as stated in the transaction statement; the 13E-3 filing date when no agreement date is stated (announcedBasis)",
    "offerPrice": "per-share cash consideration as stated in the filing, the most frequently stated figure (offerBasis is the phrase matched)",
    "premiums": "as stated in the filing, to the closing price before announcement, the 30-day VWAP and the 52-week high (premiumBasis is the sentence matched); unaffectedPrice, vwap30 and high52 are offer / (1 + premium)",
    "financials": "USD millions; sharesOut from the transaction statement when the company facts carry no count at announcement; LTM to the last fiscal period end on or before announcement (fiscal year + YTD - prior YTD), EBITDA = operating income + D&A, net debt = debt - cash and short-term investments at the same balance sheet; sharesOut = cover-page shares (dei) at the last cover date on or before announcement, millions",
    "values": "equityValue = offerPrice x sharesOut; ev = equityValue + netDebt; dealValue = the aggregate value from the filing-fee table, kept as a cross-check",
    "flags": "rows whose figures fail a sanity check (stock in the consideration, equity value far from the fee-table value, a premium above 150%, multiples out of range) are kept but flagged, and select() leaves them out",
}


def write(rows: dict[str, dict]) -> dict:
    """Finalize every row, order the file most recent first, and write it."""
    ordered = sorted((finalize(r) for r in rows.values()), key=lambda r: (r.get("announced") or "", r["id"]), reverse=True)
    counts = {
        "transactions": len(ordered),
        "withOffer": sum(1 for r in ordered if r.get("offerPrice") is not None),
        "withMultiples": sum(1 for r in ordered if r.get("evLtmEbitda") is not None),
        "withRevenueMultiple": sum(1 for r in ordered if r.get("evLtmRev") is not None),
        "withPremium": sum(1 for r in ordered if r.get("premium1Day") is not None),
        "flagged": sum(1 for r in ordered if r.get("flags")),
        "noOffer": sum(1 for r in ordered if r.get("status") == "no-offer"),
        "noConsideration": sum(1 for r in ordered if r.get("status") == "no-consideration"),
        "rejected": sum(1 for r in ordered if r.get("status") == "rejected"),
        "errors": sum(1 for r in ordered if r.get("status") == "error"),
        "takePrivates": sum(1 for r in ordered if r.get("dealType") == "take-private"),
        "publicMergers": sum(1 for r in ordered if r.get("dealType") == "public merger"),
    }
    out = {
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0, tzinfo=None).isoformat() + "Z",
        "method": METHOD,
        "counts": counts,
        "transactions": ordered,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=1) + "\n")
    return out
