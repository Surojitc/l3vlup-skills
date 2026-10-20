"""
What a filing-fee table measures, and our equity value set beside it like for like.

A take-private's fee table (the "Transaction Valuation" on a 13E-3 cover, the
"Proposed maximum aggregate value of transaction" on a proxy) is the filer's
own arithmetic, but rarely over the same perimeter as an equity value. Sungy's
counts only the shares not rolled over and adds its options and restricted
shares; Emdeon's counts the shares "owned by persons other than the Company,
Parent and Merger Sub" and adds options, RSUs and ESPP rights; Landry's counts
the 7,341,052 shares held by stockholders other than Mr. Fertitta. A ratio of
equity value to fee-table value above 1 is then the perimeter, not an error,
and a ratio near 1 is not proof either: it can hide a wrong count that
happens to sit near the public float.

So this module reads the fee table's own computation and classifies its
perimeter:

  all equity        the shares it counts are the shares outstanding
  public only       it counts only the shares of holders other than the buyer
                    group, the rollover holders or other excluded holders
  awards included   it adds options, RSUs, restricted shares or other awards
  other amounts     it adds fees, expenses or other sums

and compares like for like: our count less the excluded shares the filing
itself states (found by their sum matching the gap between our count and the
fee table's), plus the awards the fee table adds. It reports the raw ratio,
the perimeter-adjusted ratio and the perimeter. It is a report and a check,
never a reader: nothing here changes or withdraws a figure on a row.
"""

from __future__ import annotations

import itertools
import re

from . import parse

#: where a fee table states its value
_FEE_VALUE = re.compile(r"Transaction(?:al)?\s+[Vv]aluation|Aggregate\s+value\s+of\s+transaction|[Pp]roposed\s+maximum\s+aggregate\s+value\s+of\s+transaction")
_MONEY = re.compile(r"(?:US)?\$\s*([\d,]{5,}(?:\.\d+)?)")
#: where the cover's fee section ends
_FEE_END = re.compile(r"Check\s+(?:the\s+)?box\s+if\s+any\s+part\s+of\s+the\s+fee|Table\s+of\s+Contents|Dear\s+(?:Fellow\s+)?(?:Stock|Share)holder", re.I)
#: a component that is an award, not a share outstanding
_AWARD = re.compile(r"\b(?:issuable|underlying|options?|RSUs?|PSUs?|restricted\s+(?:stock|share)s?(?:\s+units?)?|restricted\s+shares?|share\s+units?|stock\s+units?|warrants?|purchase\s+rights?|appreciation\s+rights?|SARs?|awards?|ESPP|(?:EBS\s+)?[Uu]nits?\s+of\s+membership)\b", re.I)
_SHAREY = re.compile(r"\b(?:shares?|ordinary|common|ADSs?|Shares)\b", re.I)
#: words that make the fee table's share count the public's only
_PUBLIC_ONLY = re.compile(r"\bother\s+than\b|\bexclud\w*|\bnot\s+(?:owned|held|beneficially)|\bunaffiliated\b|\bRollover\b|\bExcluded\s+Shares\b|\bexclusive\s+of\b|\bheld\s+by\s+(?:stockholders|shareholders|holders|persons)\s+other", re.I)
_OTHER_AMOUNTS = re.compile(r"\b(?:plus|and)\s+(?:the\s+)?(?:estimated\s+|aggregate\s+)?(?:transaction\s+|advisory\s+|financing\s+)?(?:fees|expenses|costs)\b", re.I)
#: sentences that state shares left out of the merger consideration
_EXCLUDED_HERE = re.compile(r"\bRollover\b|\bExcluded\s+Shares\b|\bwill\s+not\s+be\s+converted\b|\bcontribut\w+\b|\b(?:owned|held)\s+(?:of\s+record\s+|beneficially\s+)?by\b|\bbeneficially\s+own\w*\b|\bown(?:s|ed)?\s+(?:in\s+the\s+aggregate\s+)?(?=\d)|\b(?:will\s+)?(?:directly\s+)?hold\s+(?=\d)|\bcancel+ed\s+(?:without|for\s+no)\b", re.I)


def accession(url: str) -> str | None:
    """The accession number a document's EDGAR path carries: .../data/<cik>/<18 digits>/<file>."""
    m = re.search(r"/data/\d+/(\d{10})(\d{2})(\d{6})/", url or "")
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else None


def fee_table(texts: list[str], urls: list[str] | None = None) -> dict | None:
    """The fee table's value ($m), its section of the cover, and the document it is in; None where no document has one."""
    for i, t in enumerate(texts):
        m = _FEE_VALUE.search(t)
        if not m:
            continue
        value = next((float(n.group(1).replace(",", "")) for n in _MONEY.finditer(t[m.end():m.end() + 400]) if float(n.group(1).replace(",", "")) > 1e5), None)
        if value is None:
            continue
        lo, hi = max(0, m.start() - 2500), min(len(t), m.end() + 3000)
        section = t[lo:hi]
        end = _FEE_END.search(section, m.end() - lo + 40)
        section = section[:end.start()] if end else section
        url = (urls or [None] * len(texts))[i]
        return {"value": round(value / 1e6, 6), "section": parse._flat(section), "url": url, "accession": accession(url)}
    return None


def _nested(text: str, at: int) -> bool:
    """Whether a count sits inside a parenthetical opened in the 250 characters before it: a part of the count before it ("115,778,777 shares ... (including 24,565,195 units ...)")."""
    depth = 0
    for ch in reversed(text[max(0, at - 250):at]):
        if ch == ")":
            depth += 1
        elif ch == "(":
            if depth == 0:
                return True
            depth -= 1
    return False


def _components(section: str) -> list[dict]:
    """The counts the fee table multiplies: each with whether it is an award, the words beside it, and none inside a parenthetical (a part of the count before it)."""
    out, seen = [], set()
    nums = [m for m in parse._NUMBER.finditer(section)]
    for i, m in enumerate(nums):
        n = float(m.group(1).replace(",", ""))
        lead = section[max(0, m.start() - 3):m.start()]
        if n < 1000 or "$" in lead or _nested(section, m.start()):
            continue
        nxt = nums[i + 1].start() if i + 1 < len(nums) else len(section)
        words = section[m.end():min(nxt, m.end() + 160)]
        if not _SHAREY.search(words[:80]) and not _AWARD.search(words[:80]):
            continue
        if n in seen:
            continue
        seen.add(n)
        own = re.split(r"\(", words, 1)[0]
        award = bool(_AWARD.search(own[:90]))
        # restricted shares are issued and outstanding: part of our count, though the fee table lists them with the awards
        outstanding = award and bool(re.search(r"\brestricted\s+(?:stock|shares?)\b(?!\s+units?)|\bissued\s+and\s+outstanding\s+restricted", own[:90], re.I))
        out.append({"count": n, "award": award, "outstandingAward": outstanding, "words": parse._flat(words[:120])})
    return out


def _stated_exclusion(texts: list[str], gap: float) -> tuple[float, list[str]] | None:
    """
    Counts of shares the documents state are left out of the consideration
    (rolled over, contributed, held by the buyer group) whose sum is the gap
    between our count and the fee table's, within 3% (the two counts are often of
    different dates), all from one sentence
    ("27,542,625 Class A ordinary shares and 13,416,800 Class B ordinary
    shares held by Perfect Human"). Each count must be tied to the words that
    leave it out, with no "outstanding" or "treasury" between: a statement of
    the capitalization is not one of shares left out. Awards are never shares
    left out. None where no sentence adds up: the difference is then named as
    not reconcilable, never forced.
    """
    if gap <= 0:
        return None
    for t in texts:
        for a, b in parse._sentences(t):
            s = t[a:b]
            if not _EXCLUDED_HERE.search(s):
                continue
            found, seen = [], set()
            for m in parse._NUMBER.finditer(s):
                n = float(m.group(1).replace(",", ""))
                after = s[m.end():m.end() + 160]
                before = s[max(0, m.start() - 120):m.start()]
                if not (0.005 * gap <= n <= 1.02 * gap) or n in seen or "$" in s[max(0, m.start() - 3):m.start()] or _AWARD.search(after[:60]) or not _SHAREY.search(after[:60]):
                    continue
                tied = (_EXCLUDED_HERE.search(after) and not re.search(r"outstanding|treasury", after[:_EXCLUDED_HERE.search(after).start()], re.I)) \
                    or (_EXCLUDED_HERE.search(before) and not re.search(r"outstanding|treasury", before[_EXCLUDED_HERE.search(before).end():], re.I))
                if not tied or re.search(r"\btreasury\b", after[:120], re.I):
                    continue
                seen.add(n)
                found.append((n, parse._flat(s[max(0, m.start() - 160):m.end() + 160])))
            for k in (1, 2, 3):
                for combo in itertools.combinations(found, k):
                    if abs(sum(x for x, _ in combo) / gap - 1) <= 0.03:
                        return sum(x for x, _ in combo), [q for _, q in combo]
    return None


def compare(row: dict, texts: list[str], urls: list[str] | None = None) -> dict | None:
    """
    The fee table beside the row's equity value: the raw ratio, what the fee
    table measures, and the perimeter-adjusted ratio (our count less the
    excluded shares the filing states, at the row's price, plus the awards
    the fee table adds), with every passage it rests on. None where the row
    has no equity value or the documents no fee table.
    """
    eq, shares = row.get("equityValue"), row.get("sharesOut")
    fee = fee_table(texts, urls)
    if not fee and row.get("dealValue"):
        fee = {"value": row["dealValue"], "section": "", "url": None, "accession": None}
    if not eq or not shares or not fee:
        return None
    price = eq / shares
    comps = _components(fee["section"])
    fee_shares = sum(c["count"] for c in comps if not c["award"]) / 1e6
    awards = [c for c in comps if c["award"]]
    held = 0.0
    perimeter = []
    excluded = None
    if fee_shares and abs(fee_shares / shares - 1) <= 0.02:
        perimeter.append("all equity")
    elif fee_shares and fee_shares < shares:
        perimeter.append("public only")
        held = sum(c["count"] for c in awards if c["outstandingAward"]) / 1e6
        excluded = _stated_exclusion(texts, (shares - fee_shares - held) * 1e6)
    elif fee_shares:
        perimeter.append("more shares than our count")
    elif fee["section"] and fee["value"] < 0.98 * eq:
        # The fee table's own count is not legible (a table the text does not
        # keep in order): the shares it implies at the row's price stand in
        # for it, named as implied, and only where the documents state the
        # excluded shares that make up the difference.
        implied = fee["value"] / price
        excluded = _stated_exclusion(texts, (shares - implied) * 1e6)
        perimeter.append("public only (implied from the fee and the price)")
    if awards:
        perimeter.append("awards included")
    # sums the fee table adds outright ("plus (b) $12,867,910 expected to be
    # paid in connection with the cancellation of ... options": Mediacom)
    plus = [float(m.group(1).replace(",", "")) / 1e6 for m in re.finditer(r"\bplus\s+(?:\([a-z]\)\s+)?(?:US)?\$\s*([\d,]{7,}(?:\.\d+)?)", fee["section"], re.I)]
    if _OTHER_AMOUNTS.search(fee["section"]) or plus:
        perimeter.append("other amounts included")
    award_value = max(0.0, fee["value"] - price * fee_shares) if awards and fee_shares else 0.0
    if plus and not awards:
        award_value = sum(plus)
    out = {"feeTable": fee["value"], "feeUrl": fee["url"], "feeAccession": fee["accession"], "rawRatio": round(eq / fee["value"], 2),
           "perimeter": perimeter or ["not stated"], "feeShares": round(fee_shares, 3) if fee_shares else None,
           "feeComponents": comps, "awardsInFee": round(award_value, 1) if awards else None}
    like = None
    if "all equity" in perimeter:
        like = eq + award_value
    elif any(p.startswith("public only") for p in perimeter) and excluded:
        n, passages = excluded
        out["excludedStated"] = round(n / 1e6, 3)
        out["excludedPassages"] = passages
        like = price * (shares - held - n / 1e6) + award_value
    elif any(p.startswith("public only") for p in perimeter):
        out["note"] = f"the fee table counts {fee_shares:,.3f}m shares against our {shares:,.3f}m, and the documents state no excluded shares that make up the {shares - fee_shares:,.3f}m between" if fee_shares else "the fee table counts the public's shares only and states no count"
    if like is not None:
        out["adjustedRatio"] = round(like / fee["value"], 2)
        out["status"] = "agrees like for like" if 0.95 <= like / fee["value"] <= 1.05 else "differs like for like"
    else:
        out["status"] = "perimeter not reconcilable from the filing"
    return out
