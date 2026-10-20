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

import copy
import json
import re
from difflib import SequenceMatcher
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from . import guard, parse

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
#: the take-private index sync-decks.mjs builds and commits
DECKS = DATA / "decks.auto.json"
OUT = DATA / "precedent-transactions.auto.json"


#: the file as it stood the first time this process read it: what guard.py protects on every write
_baseline: dict[str, dict] | None = None


def load_stored() -> dict[str, dict]:
    """Every row already on file, by id, whichever builder wrote it."""
    global _baseline
    if not OUT.exists():
        rows: dict[str, dict] = {}
    else:
        try:
            rows = {r["id"]: r for r in json.loads(OUT.read_text()).get("transactions", [])}
        except Exception:  # noqa: BLE001
            rows = {}
    if _baseline is None:
        _baseline = copy.deepcopy(rows)
    return rows


def set_baseline(rows: dict[str, dict] | None) -> None:
    """The observations a write must not lose (tests, and a caller that loads the file itself)."""
    global _baseline
    _baseline = copy.deepcopy(rows) if rows is not None else None


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


#: The acquirer reading. A guard that protects stored figures can protect the
#: acquirer from this version on: a change made under the same version is a
#: lost reading, one made under a newer version is the reader's correction.
ACQUIRER_READER = 2

#: an unaffected date more than this many days before the announcement is flagged long-unaffected-window
LONG_UNAFFECTED_DAYS = 90


def _price_per_share(row: dict) -> float | None:
    """
    The row's offer per share, or None where it is quoted per ADS with no
    ratio stated. The offer reader turns a price per ADS into one per share
    where the filing states the ratio, and leaves it per ADS (offerPerAds,
    with no offerImplied) where it does not; a row it has not read is judged
    by the phrase its price was read from.
    """
    offer = row.get("offerPrice")
    if row.get("offerReader"):
        per_ads = row.get("offerImplied") is None and row.get("offerPerAds") is not None and row.get("offerPerAds") == offer and not row.get("adsRatio")
    else:
        per_ads = bool(re.search(r"per\s+(?:ADS|American\s+Depositary)", row.get("offerBasis") or "", re.I))
    return None if per_ads else offer


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
    elif row.get("acquirer") and parse._defined_vehicle(re.sub(r"\s+", " ", row["acquirerBasis"]), row["acquirer"]):
        # A row read before the agreement's own defined terms were honoured
        # may name the merger vehicle ('ALTA Acquisition Corp. ("Merger Sub")')
        # as the buyer. The stored sentence says who its parent is.
        row["acquirer"] = parse.vehicle_parent(row["acquirerBasis"], row["acquirer"], (row.get("target") or {}).get("name") or "")
    row["acquirer"] = parse.pretty(row.get("acquirer")) or None
    # A fragment of the sentence is no buyer: a page would read that "Inc."
    # or "Holding" bought Tiffany. The parent the sentence names stands where
    # it names one; otherwise the acquirer is left empty rather than wrong.
    if row.get("acquirer") and not buyer_named(row) and not parse.same_registrant(row["acquirer"], (row.get("target") or {}).get("name") or ""):
        words = parse.norm_name(row["acquirer"]).split()
        if not words or all(w in _FRAGMENT for w in words):
            row["acquirer"] = None
    row["acquirerReader"] = ACQUIRER_READER
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

    for k in ("unaffectedPrice", "unaffectedPriceMethod", "vwap30", "high52", "equityValue", "equityValueBasis", "ev", "evLtmRev", "evLtmEbitda", "evLtmEbit", "dealValueRatio", "doubt", "unaffectedGapDays"):
        row.pop(k, None)
    # Days from the filing's unaffected date to the announcement. The filing
    # defines the unaffected day and its price is the record, but a reference
    # months before the announcement (a leak, an approach disclosed early, a
    # first agreement since revised) measures more than the deal's own
    # premium, so the gap is on the row and a long one is flagged.
    if row.get("unaffectedDate") and row.get("announced"):
        try:
            row["unaffectedGapDays"] = (date.fromisoformat(row["announced"][:10]) - date.fromisoformat(row["unaffectedDate"][:10])).days
        except ValueError:
            pass
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
    same_day = {}
    for o in row.get("offerHistory") or []:
        same_day.setdefault(o["filed"], set()).add(o["offerPrice"])
    clash = [f for f, v in same_day.items() if len(v) > 1]
    if clash:
        flag(f"filings of this deal made on {clash[0]} state different offers ({', '.join(f'${v:,.2f}' for v in sorted(same_day[clash[0]]))}): one of them is misread", "multiples")
        doubt.add("premiums")
    if row.get("consideration") in ("cash and stock", "stock"):
        flag("consideration includes stock: the cash figure is not the price", "multiples")
    # The unaffected price as the filing states it, where it does. Otherwise,
    # for an all-cash deal only, the offer over one plus the stated premium,
    # labelled as worked back: a rounded percentage ("approximately 29%") gives
    # a price that is near, not exact. A cash-and-stock deal's per-share cash is
    # not the whole consideration, so nothing is worked back from it.
    cash_only = row.get("consideration", "cash") == "cash"
    if row.get("unaffectedPriceStated") is not None:
        row["unaffectedPrice"] = row["unaffectedPriceStated"]
        row["unaffectedPriceMethod"] = "stated"
    elif row.get("premium1Day") is not None and cash_only:
        row["unaffectedPrice"] = round(offer / (1 + row["premium1Day"]), 2)
        row["unaffectedPriceMethod"] = "computed from the offer and the stated premium"
    for prem, key in (("premium30DayVwap", "vwap30"), ("premium52WeekHigh", "high52")):
        if row.get(prem) is not None and cash_only:
            row[key] = round(offer / (1 + row[prem]), 2)
    if row.get("premium1Day") is not None and (row.get("unaffectedGapDays") or 0) > LONG_UNAFFECTED_DAYS:
        flag(f"long-unaffected-window: the unaffected date is {row['unaffectedGapDays']} days before the announcement", "premiums")
    if row.get("premium1Day") is not None and row["premium1Day"] > 1.5:
        flag(f"premium of {row['premium1Day']:.0%}: distressed or misread", "premiums")
    shares = row.get("sharesOut")
    # Equity value is a price times a count in the same unit. The count is
    # always of shares: the company facts' cover count, or the transaction
    # statement's count of its ordinary or common shares (parse_shares never
    # reads a count of ADSs). LAIX's 50,173,363 are Ordinary Shares, and its
    # $0.1357 is per Ordinary Share: $6.8m, which the filing's own funding
    # need confirms ($1.92m for the 28.3% the buyers did not hold). So the
    # price must be per share: an offer quoted only per ADS, with no ratio to
    # turn it into a price per share, gives no equity value at all.
    each = _price_per_share(row)
    if shares and each is None:
        flag("the offer is quoted per ADS and the filing states no ADS ratio: no price per share to value the shares with", "multiples")
    if shares and each is not None:
        row["equityValue"] = round(each * shares, 1)
        row["equityValueBasis"] = f"${each:,.8g} a share x {shares:,.3f}m shares ({(row.get('sharesBasis') or {}).get('tag') or 'company facts'})"
        row["ev"] = round(row["equityValue"] + (row.get("netDebt") or 0.0), 1)
        if row.get("netDebt") is None:
            flag("no balance sheet at announcement: EV = equity value", "multiples")
        rev, ebitda = row.get("ltmRevenue"), row.get("ltmEbitda")
        if rev and rev > 0:
            row["evLtmRev"] = round(row["ev"] / rev, 2)
        if row.get("ltmEbit") and row["ltmEbit"] > 0:
            row["evLtmEbit"] = round(row["ev"] / row["ltmEbit"], 2)
        if ebitda and ebitda > 0:
            row["evLtmEbitda"] = round(row["ev"] / ebitda, 2)
            # EBITDA after a write-down is not the business's earnings. The
            # multiple stays on the row, but the filed impairment in the same
            # twelve months is named and puts the EBITDA multiple in doubt.
            imp = row.get("ltmImpairment")
            if imp and imp >= 0.10 * ebitda:
                flag(f"LTM EBITDA of {ebitda:,.1f} is after a tagged impairment of {imp:,.1f} ({imp / ebitda:.0%}): EV / EBITDA is not a multiple of earnings", "ebitda")
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


# ── one row per transaction ──────────────────────────────────────────────────
#
# A deal is read from every filing that states it: the 13E-3 and the merger
# proxy of one take-private, a proxy and its supplement after a raised offer,
# the same statement listed under two joint filers. Each reading stays on file
# as it was read, and one of them carries the deal:
#
#   the identity    the target's CIK and its merger agreement. Two readings of
#                   one target are the same deal where both state the
#                   agreement's date and the dates agree within a week (an
#                   amendment restates the original date), or, where either
#                   date is only a filing date, where they fall within 180 days
#                   of each other. Two buyers each named by the filings are two
#                   deals, however close the dates: a contested sale is two
#                   precedents (Netflix's and Paramount's bids for Warner Bros.
#                   Discovery), not one read twice.
#   the primary     the latest filing that states an offer, because a revised
#                   offer is the deal's final terms; where none states one,
#                   the latest filing. Its own reading stands.
#   what it borrows a field the primary's own documents did not give (the
#                   premiums, the financials at announcement, the buyer group,
#                   the advisers and the fee-table value a 13E-3 carries) is
#                   taken from another reading of the same deal, and
#                   filledFrom names the reading each came from.
#   the others      status "duplicate", duplicateOf the primary, and their own
#                   reading kept untouched beside readStatus, so nothing read is
#                   lost and the deal is counted once.
#
# Offers that differ across the readings are listed in offerHistory; where
# two readings filed on the same day disagree, the row is flagged, because
# that is a misreading rather than a revised offer.

DEAL_DAYS = 180
SAME_AGREEMENT_DAYS = 7

#: fields borrowed together, so a premium never travels without its sentence
#: and a multiple never mixes one reading's share count with another's LTM
_BORROW = (
    ("premiums", ("premium1Day", "premium30DayVwap", "premium52WeekHigh", "premiumBasis", "unaffectedPriceStated", "unaffectedDate", "unaffectedPriceBasis", "premiumStatements"), "premium1Day"),
    ("financials", ("sharesOut", "sharesBasis", "ltmRevenue", "ltmEbitda", "ltmEbit", "netDebt", "ltmPeriodEnd", "balanceSheetDate", "ebitdaBasis", "netDebtBasis", "formsUsed"), "ltmRevenue"),
    ("deck", ("buyers", "advisers", "dealValue"), "dealValue"),
)


def _day(row: dict) -> date | None:
    v = (row.get("announced") or row.get("filed") or "")[:10]
    try:
        return date.fromisoformat(v)
    except ValueError:
        return None


def _original(row: dict) -> date | None:
    """The first agreement of a revised deal, where the row records an amendment of it."""
    if row.get("announcedBasis") != "amended merger agreement" or not row.get("announcedOriginal"):
        return None
    try:
        return date.fromisoformat(row["announcedOriginal"][:10])
    except ValueError:
        return None


def _agreed(row: dict) -> date | None:
    return _day(row) if row.get("announcedBasis") == "merger agreement" else None


#: what a reading's acquirer can be without naming a buyer: a corporate suffix
#: or a holding word on its own, the pieces a split clause leaves ("Holding",
#: "Inc.", "Merger SPV.")
_FRAGMENT = {"holding", "holdings", "inc", "corp", "corporation", "co", "company", "llc", "lp", "ltd", "limited", "parent", "merger", "spv", "gp", "group", "sub", "plc"}


def _defined_as(sentence: str, term: str) -> str | None:
    """The full name a defined term stands for in the agreement sentence: 'Northern Tier Energy GP LLC (“NTI GP”)' for NTI GP."""
    m = re.search(r"\(\s*(?:the\s+)?[“\"]\s*" + re.escape(term.strip()) + r"\s*[”\"]\s*\)", sentence or "", re.I)
    if not m:
        return None
    pieces = [p.strip() for p in re.split(r",\s*", sentence[: m.start()].rstrip(" ,")) if p.strip()]
    if not pieces:
        return None
    name = pieces[-1]
    # "Western Refining, Inc." splits at its comma: the suffix joins the name before it.
    if len(pieces) > 1 and re.fullmatch(r"(?:Inc|Corp|Corporation|LLC|L\.?L\.?C|Ltd|L\.?P|LP|plc|N\.V|S\.A)\.?", name, re.I):
        name = f"{pieces[-2]}, {name}"
    name = re.sub(r"^(?:.*\bby\s+and\s+(?:among|between)\s+)", "", name, flags=re.I)
    return name or None


def _one_edit(a: str, b: str) -> bool:
    """Whether two names differ by at most one letter (a typo on a filer list: 'ReadD' for 'RealD')."""
    if abs(len(a) - len(b)) > 1 or min(len(a), len(b)) < 4:
        return False
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1] <= 1


def names_no_one(row: dict) -> bool:
    """
    Whether a reading's acquirer names no buyer at all: empty, a merger
    vehicle, a fragment of the agreement sentence, or the target and its own
    affiliates. A 13E-3 lists the target's general partner beside the buyer
    ("NTI GP" is Northern Tier Energy GP LLC, Northern Tier's own), and a
    misspelt target ("ReadD Inc." for RealD) is still the target. A name with
    no corporate suffix ("Eli Lilly", "QUALCOMM Incorporated" before the
    suffix list knew "Incorporated") is not one of these: it names someone.
    """
    a = (row.get("acquirer") or "").strip()
    if not a or parse.is_vehicle(a):
        return True
    words = parse.norm_name(a).split()
    if not words or all(w in _FRAGMENT for w in words):
        return True
    target = ((row.get("target") or {}).get("name") or "").strip()
    full = _defined_as(row.get("acquirerBasis") or "", a) or a
    for name in {a, full}:
        if target and (parse.same_company(name, target) or parse.same_registrant(name, target)):
            return True
        tw, nw = parse.norm_name(target).split(), parse.norm_name(name).split()
        # The target's own general partner or holding company: its name opens
        # with the target's first word and is a GP ("TransMontaigne GP L.L.C."
        # for TransMontaigne Partners, "Northern Tier Energy GP LLC"), or with
        # its first two words and is a holding company.
        if tw and len(nw) >= 2 and len(tw[0]) > 3 and nw[0] == tw[0] and re.search(r"\bGP\b|General\s+Partner", name, re.I):
            return True
        if len(tw) >= 2 and len(nw) >= 3 and nw[:2] == tw[:2] and re.search(r"\bHoldings?\b", name, re.I):
            return True
        if target and (SequenceMatcher(None, parse.norm_name(name), parse.norm_name(target)).ratio() >= 0.88 or _one_edit(parse.norm_name(name), parse.norm_name(target))):
            return True
    return False


def buyer_named(row: dict) -> str | None:
    """
    The buyer a reading names, as a firm, or None where it names no one (see
    names_no_one) or a name carrying no corporate suffix. Two readings that
    differ only because one holds no buyer are one deal.
    """
    a = (row.get("acquirer") or "").strip()
    if names_no_one(row) or not parse.is_firm(a):
        return None
    return a


def _buyer(row: dict) -> str | None:
    """The buyer a reading names, where it names a firm rather than a vehicle or a defined term."""
    return buyer_named(row)


def _named_in(row: dict, buyer: str) -> bool:
    """Whether a reading's own agreement sentence names this buyer as a party."""
    sentence = row.get("acquirerBasis") or ""
    core = parse.norm_name(buyer)
    return bool(core) and core in parse.norm_name(sentence)


def same_deal(a: dict, b: dict) -> bool:
    """Whether two readings of one target are the same transaction (see above)."""
    # A revised deal is dated by its amendment and keeps the agreement it
    # amended as announcedOriginal: a reading of that agreement, by the same
    # buyer, is the same deal (iRobot's $61.00 of August 2022, revised to
    # $51.75 in July 2023).
    for x, y in ((a, b), (b, a)):
        oa, gy = _original(x), _agreed(y) or _original(y)
        if oa and gy and abs((oa - gy).days) <= SAME_AGREEMENT_DAYS:
            bx, by = _buyer(x), _buyer(y)
            if not (bx and by) or parse.same_company(bx, by) or parse.same_registrant(bx, by):
                return True
    ba, bb = _buyer(a), _buyer(b)
    if ba and bb and not parse.same_company(ba, bb) and not parse.same_registrant(ba, bb):
        # Two buyers are two deals unless both are parties to one agreement:
        # each reading names the other's buyer in its agreement sentence
        # (Medley Management's merger with Sierra Income, to which Medley
        # Capital is also a party).
        if not (_named_in(a, bb) or _named_in(b, ba)):
            return False
    ga, gb = _agreed(a), _agreed(b)
    if ga and gb:
        return abs((ga - gb).days) <= SAME_AGREEMENT_DAYS
    da, db = _day(a), _day(b)
    return bool(da and db) and abs((da - db).days) <= DEAL_DAYS


def deal_groups(rows: dict[str, dict]) -> list[list[dict]]:
    """The readings of each transaction, oldest first; a rejected or failed reading is no deal's."""
    by_target: dict[str, list[dict]] = {}
    for r in rows.values():
        if r.get("status") in ("rejected", "error"):
            continue
        cik = str((r.get("target") or {}).get("cik") or "").zfill(10)
        if cik.strip("0"):
            by_target.setdefault(cik, []).append(r)
    groups: list[list[dict]] = []
    for readings in by_target.values():
        readings.sort(key=lambda r: (_day(r) or date.min, r.get("filed") or "", r["id"]))
        mine: list[list[dict]] = []
        for r in readings:
            home = next((g for g in mine if all(same_deal(r, x) for x in g)), None)
            if home is None:
                mine.append([r])
            else:
                home.append(r)
        groups.extend(mine)
    return groups


def _primary(group: list[dict]) -> dict:
    priced = [r for r in group if r.get("status") == "ok" and r.get("offerPrice") is not None]
    pool = priced or group
    return max(pool, key=lambda r: (r.get("filed") or "", -len(r.get("flags") or []), r["id"]))


def dedupe(rows: dict[str, dict]) -> dict[str, dict]:
    """
    One row per transaction (see above). Idempotent: every earlier marking and
    every borrowed field is taken back off first, so a run that adds a reading
    re-decides the deal from the readings themselves.
    """
    for r in rows.values():
        if r.get("readStatus"):
            r["status"] = r.pop("readStatus")
        r.pop("duplicateOf", None)
        # A borrowed field is given back only while it is still the donor's
        # value: a field the row has since read for itself stays.
        for f, donor in (r.pop("filledFrom", None) or {}).items():
            if donor in rows and r.get(f) == rows[donor].get(f):
                r.pop(f, None)
        for k in ("dealId", "readings", "offerHistory"):
            r.pop(k, None)
    ids: dict[str, list[dict]] = {}
    for group in deal_groups(rows):
        primary = _primary(group)
        first = min(min(d for d in (_day(r), _original(r)) if d) if (_day(r) or _original(r)) else date.max for r in group)
        primary["dealId"] = f"{str(primary['target']['cik']).zfill(10)}:{first.isoformat() if first != date.max else primary['id']}"
        ids.setdefault(primary["dealId"], []).append(primary)
        if len(group) == 1:
            continue
        primary["readings"] = [{"id": r["id"], "form": r.get("source") or "SC 13E3", "filed": r.get("filed"), "url": r.get("filingUrl"), "status": r.get("status"), "offerPrice": r.get("offerPrice")} for r in group]
        offers = sorted({(r.get("filed") or "", r["offerPrice"]) for r in group if r.get("status") == "ok" and r.get("offerPrice") is not None})
        if len({o for _, o in offers}) > 1:
            primary["offerHistory"] = [{"filed": f, "offerPrice": o} for f, o in offers]
        filled: dict[str, str] = {}
        for what, fields, probe in _BORROW:
            if primary.get(probe) not in (None, [], ""):
                continue
            candidates = [r for r in sorted(group, key=lambda r: r.get("filed") or "", reverse=True) if r is not primary and r.get(probe) not in (None, [], "")]
            if what == "premiums":
                # A premium belongs to the offer it was stated for: a reading
                # of the same offer may lend its premium, a reading of a
                # different offer never does (iRobot's $51.75 is not 22% over
                # anything: the 22% was the $61.00 offer's).
                po = primary.get("offerPrice")
                candidates = [r for r in candidates if po is None or r.get("offerPrice") is None or abs(r["offerPrice"] - po) <= 0.005 * po]
            donor = next(iter(candidates), None)
            if donor:
                for f in fields:
                    if donor.get(f) not in (None, [], "") and primary.get(f) in (None, [], ""):
                        primary[f] = donor[f]
                        filled[f] = donor["id"]
        # The deal's buyer, where the primary's own reading names none (a
        # 13E-3 that lists the target's general partner, a clause fragment):
        # the latest reading that names one, and filledFrom says which.
        if names_no_one(primary):
            named = next((r for r in sorted(group, key=lambda r: r.get("filed") or "", reverse=True) if r is not primary and buyer_named(r)), None)
            if named:
                primary["acquirer"] = named["acquirer"]
                filled["acquirer"] = named["id"]
        if filled:
            primary["filledFrom"] = filled
        for r in group:
            if r is primary:
                continue
            r["readStatus"] = r.get("status")
            r["status"] = "duplicate"
            r["duplicateOf"] = primary["id"]
            r["dealId"] = primary["dealId"]
    # Two deals for one target dated the same day (a contested sale read with
    # one agreement date) keep one identity each: the later primary's carries
    # its buyer (Neff: H&E Equipment Services and United Rentals).
    for did, prims in ids.items():
        if len(prims) < 2:
            continue
        for p in sorted(prims, key=lambda r: (r.get("filed") or "", r["id"]))[1:]:
            slug = re.sub(r"[^a-z0-9]+", "-", parse.norm_name(p.get("acquirer") or p["id"])).strip("-")[:40] or p["id"]
            new = f"{did}:{slug}"
            for r in rows.values():
                if r.get("dealId") == did and (r is p or r.get("duplicateOf") == p["id"]):
                    r["dealId"] = new
    return rows


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
    "acquirer": "for a take-private, the buyer a page names from the 13E-3 filer list; for a merger proxy, the first named party of the merger agreement sentence that is neither the target nor a merger vehicle (acquirerBasis is the sentence), null where the parties are named only by defined term or the reading names no one (a sentence fragment such as 'Inc.', the merger vehicle, the target's own general partner); the primary then takes the buyer the latest reading of the deal names (filledFrom.acquirer). acquirerReader is the version of this rule",
    "dealId": "one transaction: the target's CIK and the date of its earliest reading. A deal read from several filings (a 13E-3 and its proxy, a proxy and its supplement) has one primary row, the latest filing to state an offer; the others are status 'duplicate' with duplicateOf the primary and their own reading kept under readStatus. readings lists every filing of the deal, offerHistory the offers they state where they differ, filledFrom the reading each borrowed field came from. Two buyers each named by the filings are two deals, unless each is a party to the other's agreement; a second deal for one target that starts on the same day carries its buyer after the date",
    "status": "ok, duplicate (another reading of a deal on file under duplicateOf), no-offer (read, no per-share cash figure stated), no-consideration (an acquirer-side vote: the filer's own holders voted on issuing shares, or a joint proxy whose registrant issues the shares and so is the buyer, acquirerSideBasis the sentences that say so), rejected (a blank-check shell, a fund reorganisation, or a tender offer for warrants, notes or dividend-bearing preferred stock rather than the company's equity: not a precedent transaction; error says which, and securitiesSought the class the 13E-3 cover names) or error",
    "announced": "the merger agreement date as stated in the transaction statement; the 13E-3 filing date when no agreement date is stated (announcedBasis). announcedReader is the date rule's version: 2 reads only the deal's own agreement (a merger, arrangement, transaction, implementation or business combination agreement, or the purchase, sale, contribution or share exchange agreement of an asset sale or share purchase), never a credit, settlement, lease, confidentiality, voting or financing agreement the proxy recites. A date moves only when that version, the target or the classification does, and the LTM financials move with it",
    "reverseMergerBasis": "dealType 'reverse-merger': the proxy states that a private company's holders will own the majority (60% or more) of the listed company and its current holders the rest; the sentence and both stakes are kept. Such a row is not a control acquisition of the listed company",
    "spacEvidence": "for a merger proxy, how often its documents mention a trust account, an initial business combination, a blank-check company and a special purpose acquisition company; a proxy with at least 100 of the first and 5 of any other is a de-SPAC and rejected (spacRule 2), whatever its counterparty is called",
    "offerPrice": "per-share cash consideration as stated in the filing, the most frequently stated figure (offerBasis is the phrase matched)",
    "offerImplied": "the whole offer per share (offerReader 4): the cash of an all-cash deal, or a package with stock, an all-stock deal included, at the value its filing states for it on the last trading day before the announcement, as the agreed price or on a date near the agreement ('stated', offerImpliedDate), or as the filing works it from its own parts, an exchange ratio times the acquirer's stated close, plus any cash ('computed from stated components'). A value stated only at the proxy's practicable date is never the offer, no ratio is assumed and no price looked up: such a row carries offerUnresolved instead. offerComponents keeps every part with its passage and document; consideration is 'stock' where no cash is part of the package. premiumTie says whether the premium was checked against the whole offer: a stock package's premium is checked only on the day the package is valued, or where its stated price reproduces it",
    "premiums": "as the filing states them for its own deal, to the unaffected close (the last trading day before the news, as the filing defines it), the 30-trading-day VWAP and the 52-week high; a financial adviser's analysis (an illustrative range, comparable deals), an earlier proposal and the terms of another instrument (a capped call's cap, a conversion, exercise or strike price) are never read as the deal's premium, nor, for an all-cash deal, a statement whose reference price plus its premium is not the final offer to within two points (another bid's), unless it names the agreed consideration. premiumStatements lists every statement kept with its document, premiumsSetAside the ones left out and why, premiumBasis the sentences chosen. A 30-day VWAP or 52-week-high premium measured to the same day as a kept unaffected statement is kept with sharesReference true, and fills only a basis the agreement window left empty; a premium is borrowed from another reading only where that reading states the same offer",
    "unaffectedGapDays": "days from unaffectedDate to announced; a row whose gap exceeds 90 days is flagged 'long-unaffected-window: ...' with its premiums in doubt, and keeps the filing's own unaffected price. premiumPreAnnouncement (and its date) is the premium the filing states to the last close before the announcement, where it states one",
    "announcedBasis": "merger agreement (the agreement's date as stated), amended merger agreement (a revised deal: the latest amendment or restatement, where the filings state that it revised the agreed price to the row's offer; announcedOriginal the first agreement's date, which also dates the deal's dealId) or filing date (no agreement date stated)",
    "unaffectedPrice": "the closing price the filing states for the unaffected date (unaffectedPriceMethod 'stated', unaffectedDate the date); for an all-cash deal whose filing states only the percentage, offer / (1 + premium1Day) ('computed from the offer and the stated premium'); none for a deal paid partly in stock. vwap30 and high52 are offer / (1 + premium), all-cash deals only",
    "financials": "USD millions; sharesOut from the transaction statement when the company facts carry no count at announcement: the count of shares (common, ordinary or Class A) or common units it states as outstanding, never of ADSs, the most often stated; a count of shares issuable under or underlying options, awards, RSUs, warrants, convertibles or plans, reserved, held in treasury, a holding stated as a percentage of the outstanding, or a count of preferred stock is passed over, and where the statement gives no other there is no count and no equity value; LTM to the last fiscal period end on or before announcement (fiscal year + YTD - prior YTD), EBITDA = operating income + D&A, net debt = debt - cash and short-term investments at the same balance sheet; sharesOut = cover-page shares (dei) at the last cover date on or before announcement, millions. Revenue is the filed total: a larger Revenues figure for the same period replaces a part of it (a REIT's contract revenue beside its rent). A figure under $1m keeps thousands, so 0.0 means the filing says zero. companyFactsMissing is the day EDGAR last answered that it has no company facts for the target; such a row keeps what it has and is asked again after 183 days",
    "values": "equityValue = offerPrice x sharesOut, both per share (equityValueBasis says so): sharesOut is a count of shares, never of ADSs, and an offer quoted only per ADS with no ratio stated gives no equity value; ev = equityValue + netDebt; dealValue = the aggregate value from the filing-fee table, kept as a cross-check; evLtmEbit = ev / ltmEbit, LTM operating income to ltmEbitEnd, kept whether or not EBITDA could be built",
    "periods": "each multiple has one period: EV at the deal against LTM revenue to ltmRevenueEnd (revenueTag the concept read), or against LTM EBITDA to ltmEbitdaEnd, whose operating income and D&A end within a week of each other. Revenue and D&A fall back to a utility's or a goods company's own concepts only where none of the usual ones is current. ltmImpairment is the impairment the filing tags inside the EBITDA's twelve months; at 10% of EBITDA or more the row is flagged and doubt includes 'ebitda'",
    "revisions": "every change a run made to a sourced figure or the acquirer (offer, consideration, deal value, premiums and the unaffected price, shares, LTM revenue, EBITDA and EBIT, net debt): run, field, from, to and cause (a reader version moving forward, a target re-identified, a reclassification, or read again), newest 20 kept. A re-read that fails, or that loses a figure without one of those causes, keeps the prior reading (readErrors says so); a run that would withdraw a figure from more than 5% of the rows carrying it is refused (scripts/precedent_transactions/guard.py)",
    "flags": "rows whose figures fail a sanity check (stock in the consideration, equity value far from the fee-table value, a premium above 150%, multiples out of range) are kept but flagged, and select() leaves them out",
}


def write(rows: dict[str, dict]) -> dict:
    """
    Finalize every row, order the file most recent first, and write it, after
    guard.py has put back what this run lost without a reason and checked that
    no field loses too much at once (GuardRefused leaves the file as it was).
    """
    dedupe(rows)
    if _baseline:
        report = guard.protect(_baseline, rows)
        guard.check(_baseline, rows, report)
    ordered = sorted((finalize(r) for r in rows.values()), key=lambda r: (r.get("announced") or "", r["id"]), reverse=True)
    counts = {
        "transactions": len(ordered),
        "deals": sum(1 for r in ordered if r.get("status") != "duplicate"),
        "duplicates": sum(1 for r in ordered if r.get("status") == "duplicate"),
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
        "reverseMergers": sum(1 for r in ordered if r.get("dealType") == "reverse-merger"),
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
