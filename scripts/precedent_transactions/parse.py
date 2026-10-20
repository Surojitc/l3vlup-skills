"""
Reading a merger filing: the pure functions, over text that is already fetched.

Nothing here touches the network or the disk, which is what makes each of these
answerable on its own. A filing states its own agreement date, its own price and
its own premiums; the work is telling those apart from the dozen other dollar
figures and percentages on the same page, and from the earlier proposals a proxy
recites in its background section.
"""

from __future__ import annotations

import copy
import re
from collections import Counter
from datetime import date
from functools import lru_cache

MONTHS = {m: i for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"], 1)}
MONTHS.update({k[:3]: v for k, v in list(MONTHS.items())})
MONTHS["sept"] = 9

_DATE = r"([A-Z][a-z]+\.?)\s+(\d{1,2}),?\s+(\d{4})"


def iso_date(m: str, d: str, y: str) -> str | None:
    mm = MONTHS.get(m.lower().rstrip("."))
    if not mm:
        return None
    try:
        return date(int(y), mm, int(d)).isoformat()
    except ValueError:
        return None


# ── the merger agreement date ────────────────────────────────────────────────


def parse_agreement_date(text: str) -> str | None:
    """The date of the merger agreement, the most often stated when the document names it more than once."""
    found: Counter = Counter()
    for m in re.finditer(r"Agreement and Plan of Merger[^.]{0,160}?dated(?:\s+as\s+of)?\s+" + _DATE, text):
        iso = iso_date(m.group(1), m.group(2), m.group(3))
        if iso:
            found[iso] += 1
    return found.most_common(1)[0][0] if found else None


_AMENDED = [
    # "Amendment No. 1 to Agreement and Plan of Merger, dated as of June 24, 2020"
    r"Amendment(?:\s+No\.\s*\d+)?\s+to\s+(?:the\s+)?(?:Amended\s+and\s+Restated\s+)?(?:Agreement\s+and\s+Plan\s+of\s+Merger|Merger\s+Agreement)[^.]{0,120}?dated(?:\s+as\s+of)?\s+" + _DATE,
    # "the Agreement and Plan of Merger, dated as of January 30, 2016, as amended on April 13, 2017"
    r"Agreement\s+and\s+Plan\s+of\s+Merger,?\s+dated(?:\s+as\s+of)?\s+[A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4},?\s+(?:as\s+amended|as\s+modified)[^.;]{0,60}?(?:on|as\s+of|dated(?:\s+as\s+of)?)\s+" + _DATE,
    # "Amended and Restated Agreement and Plan of Merger, dated as of July 9, 2017"
    r"Amended\s+and\s+Restated\s+Agreement\s+and\s+Plan\s+of\s+Merger[^.]{0,120}?dated(?:\s+as\s+of)?\s+" + _DATE,
]


def parse_amendment_date(text: str) -> str | None:
    """
    The latest date on which the merger agreement was amended or restated, as
    the document states it: the agreement whose terms a revised deal records
    (Alere's $51.00 is the April 2017 amendment's, not the January 2016
    agreement's $56.00).
    """
    dates = []
    for pat in _AMENDED:
        for m in re.finditer(pat, text):
            iso = iso_date(m.group(1), m.group(2), m.group(3))
            if iso:
                dates.append(iso)
    return max(dates) if dates else None


_REVISED = re.compile(r"(?:increas|reduc|rais|lower|revis|amend|chang)\w*[^.;]{0,160}?\bfrom\s+(?:US)?\$\s?(\d{1,4}(?:,\d{3})*(?:\.\d{1,4})?)[^.;$]{0,60}?\bto\s+(?:US)?\$\s?(\d{1,4}(?:,\d{3})*(?:\.\d{1,4})?)", re.I)


#: what ties a stated price change to an agreement already signed: an
#: amendment, or the original agreement it changed
_AMENDED_FROM = re.compile(r"amend|original\s+(?:merger\s+)?agreement|as\s+set\s+forth\s+in\s+the", re.I)


def price_revised(texts: list[str], offer: float | None) -> bool:
    """
    Whether the documents state that an agreed price was revised to the offer
    the row records: 'the price per share ... would be reduced from $61.00 in
    cash, to $51.75 in cash' beside the amendment that did it. A price raised
    during the negotiation ('increase the proposed price from $6.50 per share
    to $6.60', 'resulted in an increase in the offer price from $41.00 to
    $43.50') was never agreed and revises nothing, so the change must name a
    consideration or price, sit within a few lines of an amendment or the
    original agreement, and not be a proposal's.
    """
    if not offer:
        return False
    for t in texts:
        for m in _REVISED.finditer(t):
            try:
                old, new = float(m.group(1).replace(",", "")), float(m.group(2).replace(",", ""))
            except ValueError:
                continue
            if not (abs(new - offer) <= 0.005 * offer and abs(old - new) > 0.005 * offer):
                continue
            head = re.sub(r"\bfrom\s+(?:US)?\$\s?$", "", t[max(0, m.start(1) - 200): m.start(1)])
            if not re.search(r"(?:consideration|price)\b[^.;$]{0,120}$", head, re.I) or re.search(r"propos", t[max(0, m.start() - 30): m.end()], re.I):
                continue
            if _AMENDED_FROM.search(t[max(0, m.start() - 250): m.end()]):
                return True
    return False


#: the agreement a merger proxy is about, by its own names for it: a merger,
#: arrangement, amalgamation, transaction, implementation or business
#: combination agreement, and, for the asset sales and share purchases a proxy
#: also puts to a vote, the purchase, sale, contribution, acquisition or share
#: exchange agreement. A credit, settlement, lease, employment, voting,
#: confidentiality or subscription agreement never dates a deal, nor does a
#: securities or note purchase agreement (a financing).
_DEAL_AGREEMENT = (
    r"(?:[Mm]erger\s+[Aa]greement|Agreement\s+and\s+Plan\s+of\s+(?:Merger|Amalgamation|Arrangement|Reorganization|Share\s+Exchange)|Plan\s+of\s+(?:Merger|Share\s+Exchange)"
    r"|[Aa]rrangement\s+[Aa]greement|[Aa]malgamation\s+[Aa]greement|[Tt]ransaction\s+[Aa]greement|[Ii]mplementation\s+[Aa]greement|(?:[Bb]usiness\s+)?[Cc]ombination\s+[Aa]greement"
    r"|(?:[Aa]sset|[Ss]tock|[Ss]hare|[Ee]quity|[Uu]nit|[Mm]embership\s+[Ii]nterests?|[Ss]tock\s+and\s+[Aa]sset)\s+[Pp]urchase\s+[Aa]greement|Purchase\s+Agreement"
    r"|(?:[Aa]sset\s+)?[Pp]urchase\s+and\s+[Ss]ale\s+[Aa]greement|[Ss]ale\s+and\s+[Pp]urchase\s+[Aa]greement|(?:[Aa]sset\s+)?Sale\s+Agreement|[Cc]ontribution\s+(?:(?:and|&)\s+[Ee]xchange\s+)?[Aa]greement|[Aa]cquisition\s+[Aa]greement"
    r"|(?:[Ss]hare|[Ee]quity)\s+[Ee]xchange\s+[Aa]greement|Simplification\s+Agreement|Unification\s+Agreement|[Dd]efinitive\s+(?:[a-z]+\s+)?agreement)\b"
)

_AGREEMENT_LOOSE = [
    r"(?:[Mm]erger\s+[Aa]greement|Arrangement\s+Agreement|Agreement\s+and\s+Plan\s+of\s+(?:Merger|Amalgamation)|Transaction\s+Agreement|Implementation\s+Agreement)[^.;]{0,80}?dated(?:\s+as\s+of)?\s+" + _DATE,
    r"dated(?:\s+as\s+of)?\s+" + _DATE + r"[^.;]{0,30}?\((?:as\s+it\s+may\s+be\s+amended[^)]*)?(?:the\s+)?[“\"]\s*(?:[Mm]erger|Arrangement|Transaction|Amalgamation)\s+[Aa]greement",
    # "On August 13, 2017, Tesco Corporation entered into an Arrangement
    # Agreement": only the deal's own agreement. Any agreement entered into
    # used to count, and a proxy recites dozens: TESCO's mediated settlement
    # agreement, ADTRAN's revolving credit agreement and Gaia's line of credit
    # outnumbered the merger itself, and the financials were read at their dates.
    r"[Oo]n\s+" + _DATE + r",\s+[^.;]{0,120}?entered\s+into\s+(?:an?|the)\s+(?:(?:[Aa]mended\s+and\s+[Rr]estated|[Dd]efinitive|[Bb]inding|[Mm]aster)\s+)?" + _DEAL_AGREEMENT,
]


def parse_agreement_date_loose(text: str, floor: str, ceiling: str) -> str | None:
    """
    The agreement date where the document never writes "Agreement and Plan of
    Merger, dated ...": "the merger agreement, dated as of July 7, 2024",
    "dated June 15, 2014 (the "Transaction Agreement")", "On March 10, 2014,
    ... entered into a merger agreement". The most often stated date between
    `floor` and `ceiling` (the filing), or None.
    """
    found: Counter = Counter()
    for pat in _AGREEMENT_LOOSE:
        for m in re.finditer(pat, text):
            iso = iso_date(m.group(1), m.group(2), m.group(3))
            if iso and floor <= iso <= ceiling:
                found[iso] += 1
    return found.most_common(1)[0][0] if found else None


# ── the offer ────────────────────────────────────────────────────────────────

_AMT = r"(?:US\s?)?\$\s?(\d{1,4}(?:,\d{3})*\.\d{2,4})"
_OFFER_PATTERNS = [
    rf"{_AMT}\s+(?:per\s+(?:share|unit|ADS|common share|ordinary share|Class A [a-z ]*share)[^$.]{{0,40}}?)?in\s+cash",
    rf"in\s+cash[^$.;]{{0,40}}?{_AMT}",
    rf"right\s+to\s+receive[^$.;]{{0,90}}?{_AMT}",
    rf"[Mm]erger\s+[Cc]onsideration(?:\s+of|,?\s+being|,?\s+equal\s+to|\s+is|\s+will\s+be|\s+means)\s+(?:an\s+amount\s+(?:in\s+cash\s+)?equal\s+to\s+)?{_AMT}",
    rf"cash\s+(?:equal\s+to|of|in\s+the\s+amount\s+of|payment\s+of)\s+{_AMT}",
    rf"{_AMT}\s+per\s+(?:share|unit|ADS)\s+(?:in\s+cash|merger\s+consideration|offer|purchase\s+price|consideration)",
    rf"(?:offer|purchase|per\s+share)\s+price\s+of\s+{_AMT}",
]
_NOT_OFFER = re.compile(r"par\s+value|increase\s+of|decrease\s+of|less\s+than|more\s+than|in\s+excess\s+of|reduction\s+of|per\s+share\s+for\s+the\s+(?:first|second|third|fourth)|fee|expense|dividend|termination", re.I)


def parse_offer(text: str) -> tuple[float | None, str | None]:
    """The per-share cash consideration: the figure the document states most often, with the phrase it was read from."""
    found: Counter = Counter()
    phrase: dict[float, str] = {}
    for pat in _OFFER_PATTERNS:
        for m in re.finditer(pat, text):
            before = text[max(0, m.start() - 60):m.start()]
            if _NOT_OFFER.search(before) or _NOT_OFFER.search(m.group(0)):
                continue
            # "a purchase price of $10.25 million" is a building the company
            # sold, not what a shareholder is paid for one share.
            if re.match(r"\s*(?:million|billion|thousand|mm\b|bn\b)", text[m.end():m.end() + 12], re.I):
                continue
            # A contingent value right's payment is not the price: "one CVR
            # ..., which each represent the right to receive a contingent
            # payment of $0.10 in cash" (Orchard), "up to $3.00 in cash"
            # (Fusion), "a maximum aggregate amount of $4.90 in cash" (Innocoll).
            lead = text[max(0, m.start() - 200):m.start()]
            lead = lead[max(lead.rfind(". "), lead.rfind(";"), lead.rfind("•")) + 1:]
            if re.search(r"contingent|\bCVRs?\b|milestone", lead + m.group(0)) or re.match(r"[^.;]{0,20}per\s+CVR", text[m.end():m.end() + 30]):
                continue
            try:
                v = float(m.group(1).replace(",", ""))
            except ValueError:
                continue
            if not 0.05 <= v <= 10_000:
                continue
            found[v] += 1
            phrase.setdefault(v, re.sub(r"\s+", " ", m.group(0)).strip())
    if not found:
        return None, None
    v, _ = found.most_common(1)[0]
    return v, phrase[v]


_MIXED = re.compile(r"[“\"](?:Exchange Ratio|Stock Consideration|Share Consideration|Stock Election|Cash Election|Mixed Consideration)[”\"]|\d\.\d{2,4}\s+(?:of\s+an?\s+|validly\s+issued\s+|fully\s+paid\s+)*(?:shares?|units?)\s+of\b", re.I)


def mixed_consideration(text: str) -> bool:
    """Whether the consideration includes stock or units: a per-share cash figure alone then misstates the price."""
    return len(_MIXED.findall(text)) >= 2


# ── the whole offer ──────────────────────────────────────────────────────────
#
# parse_offer reads the per-share cash, which is the whole price only for a
# cash deal quoted per share. A premium is measured on the whole package and in
# the unit its reference price is quoted in, so before a premium is tied to the
# offer (premium_statements) the offer is put in the same terms, and every part
# of it is kept with the passage it was read from (read_offer):
#
#   ADS     an ADS deal's premiums are to the ADS price. The ADS ratio is read
#           where the filing states it ("because each ADS represents four
#           Shares"), and the offer per ADS is the per-share cash times it.
#           A ratio is never assumed: with none stated, only the per-share
#           offer ties.
#   stock   a cash-and-stock or all-stock package is worth what the filing
#           says it was worth on the reference day ("Based on the closing
#           price of Aetna common shares on ... August 17, 2012, the last
#           trading day before the public announcement ..., the merger
#           consideration represented approximately $42.08 in value"), or what
#           its stated parts add to: a stock part fixed in dollars ("a fraction
#           of a share of UTC common stock equal to the quotient obtained by
#           dividing $46.67 by" its average price), or the filing's own sum of
#           an exchange ratio times the acquirer's price on a stated date plus
#           the cash. A value stated only at the proxy's practicable date is
#           kept as a component and is never what a premium is tied to.
#   CVR     a contingent payment ("10 CVRs per Orchard ADS, which each
#           represent the right to receive a contingent payment of $0.10 in
#           cash") is not the price: parse_offer passes over it.
#   unit    a price the filings quote per ADS ("US$0.15 in cash per ADS")
#           is per ADS even where the phrase it was read from says only "in
#           cash"; the per-share price is the one the filing states beside it
#           ("US$0.05 per Ordinary Share, or ... US$0.15 per ADS").
#   payout  cash paid with a special dividend or a distribution the filing
#           values with it ("$21.00 per Share ... in conjunction with a
#           special dividend from the Company of $5.00 per Share, representing
#           an aggregate transaction value to Company shareholders of $26.00
#           per Share") is worth that stated total, and its premiums are to it.
#
# Where the consideration includes stock and none of these gives its value, the
# offer is unresolved and says why: there is nothing to tie a premium to, and
# the filing's own statement stands untied (filings.apply_premiums).

_NUMBER_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17,
    "eighteen": 18, "nineteen": 19, "twenty": 20, "twenty-five": 25, "thirty": 30, "forty": 40, "fifty": 50,
    "one hundred": 100, "two hundred": 200,
}
_TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}
_UNITS = {w: n for w, n in _NUMBER_WORDS.items() if n < 10}
#: a compound written out, as the filings and their conversion to text leave
#: it: "seventy-two", "seventy -two" (Zhangmen's cover), "seventy two"
_COMPOUND = r"(?:" + "|".join(_TENS) + r")(?:\s*-\s*|\s+)(?:" + "|".join(_UNITS) + r")\b"
_COUNT = r"(\d{1,3}(?:\.\d{1,4})?|" + _COMPOUND + "|" + "|".join(sorted((re.escape(w) for w in list(_NUMBER_WORDS) + list(_TENS)), key=len, reverse=True)) + r")"
#: "ADSs, each representing four Shares", "each ADS represents 50 Shares",
#: "each Verona ADS represents a beneficial interest in eight Verona ordinary
#: shares", "American Depositary Shares, each of which represents 18 Ordinary Shares"
_ADS_RATIO = re.compile(
    r"\b(?:ADSs?|American\s+[Dd]epositary\s+[Ss]hares?)\b[”\")]*\s*(?:\([^)]{0,60}\)\s*)?,?\s*(?:evidenced\s+by\s+[^,]{0,60},\s*)?"
    r"(?:each\s+(?:of\s+which\s+)?|which\s+)?represent(?:s|ing)?\s+(?:a\s+beneficial\s+(?:ownership\s+)?interest\s+in\s+)?"
    + _COUNT + r"(?:\s*\(\d{1,3}\))?\s+(?:of\s+(?:the\s+Company[’']s\s+|our\s+)?)?(?:[A-Z][\w.&’'-]*\s+){0,2}?(?:Class\s+[A-Z]\s+)?(?:[Oo]rdinary\s+|[Cc]ommon\s+)?[Ss]hares?\b",
)


def _count(word: str) -> float | None:
    w = re.sub(r"\s*-\s*|\s+", "-", word.lower().strip())
    if w.replace("-", " ") in _NUMBER_WORDS:
        return float(_NUMBER_WORDS[w.replace("-", " ")])
    if w in _NUMBER_WORDS:
        return float(_NUMBER_WORDS[w])
    if w in _TENS:
        return float(_TENS[w])
    tens, _, unit = w.partition("-")
    if tens in _TENS and unit in _UNITS:
        return float(_TENS[tens] + _UNITS[unit])
    try:
        return float(w)
    except ValueError:
        return None


def ads_ratio(texts: list[str]) -> tuple[float | None, str | None]:
    """The shares one ADS represents, as the filings state it, with the passage; None where none is stated or two ratios are."""
    found: Counter = Counter()
    phrase: dict[float, str] = {}
    for text in texts:
        for m in _ADS_RATIO.finditer(text):
            # Not a ratio being changed ("an ADS consolidation from one ADS
            # representing 19 common shares to one ADS representing one common
            # share": Pactera), and not the acquirer's own ADSs ("each Parent
            # ADS represents five ordinary shares of Parent": Chiasma).
            before = text[max(0, m.start() - 120):m.start()]
            if re.search(r"consolidation|ratio\s+change|change\s+(?:in|of|to)\s+the\s+(?:ADS\s+)?ratio|\bfrom\s+one\s*$", before, re.I) or re.search(r"\bParent\s*$|\bParent[’']s\s*$", before):
                continue
            v = _count(m.group(1))
            if not v or not 0.01 <= v <= 1000:
                continue
            found[v] += 1
            phrase.setdefault(v, re.sub(r"\s+", " ", text[max(0, m.start() - 60):m.end() + 40]).strip())
    if not found:
        return None, None
    (v, n), *rest = found.most_common()
    # A filing that states two ratios (a ratio change) as often as each other
    # gives no ratio to work with.
    if rest and rest[0][1] == n:
        return None, None
    return v, phrase[v]


_MONEY = r"(?:US\s?)?\$\s?(\d{1,4}(?:,\d{3})*(?:\.\d{1,4})?)(?![\d,]|\.\d|\s*(?:million|billion|thousand|mm\b|bn\b))"
#: a stock part fixed in dollars: "a fraction of a share of UTC common stock
#: equal to the quotient obtained by dividing $46.67 by the average ...",
#: "an exchange ratio, which will be calculated by dividing $1.27 by the ..."
_FIXED_STOCK = re.compile(
    r"(?:fraction\s+of\s+a\s+share|number\s+of\s+(?:shares|units))\s+of\s+[^.;$]{0,80}?(?:equal\s+to|equals)\s+[^.;$]{0,80}?(?:obtained\s+by\s+|calculated\s+by\s+)?dividing\s+" + _MONEY + r"\s+by\b",
    re.I,
)
#: an exchange ratio in the consideration: "0.3885 of an Aetna common share",
#: "0.5 of a share of AAM common stock", "0.9856 common units of Breitburn",
#: "1.9 shares ... of XING", "0.5775 (the “Exchange Ratio”) of a common unit"
_RATIO = re.compile(
    r"(?<![\d.$])(\d{1,2}\.\d{1,5})\s+(?:\(the\s+[“\"]?Exchange\s+Ratio[”\"]?\)\s+)?(?:\([^)]{0,50}\)\s+)?(?:of\s+(?:an?|one)\s+)?(?:validly\s+issued,?\s+|fully\s+paid,?\s+(?:and\s+)?|non-?assessable\s+|freely[\s-]tradeable\s+)*"
    r"(?:[A-Z][\w.&’'-]*\s+){0,3}?(?:(?:common|ordinary|Class\s+[A-Z])\s+)?(?:shares?|units?|stock)\b",
)
#: who receives what: the consideration sentence, not an option or a rollover
_RECEIVE = re.compile(r"right\s+to\s+receive|converted\s+(?:automatically\s+)?into|entitled\s+to\s+receive|will\s+receive|exchanged\s+for|receive\s+the\s+following", re.I)
#: Also an operating partnership's units (Taubman's OP unitholders could elect
#: Simon units; its shareholders were paid cash), and the acquirer's own shares
#: moving into a holding company ("each ASE share ... (including ASE's
#: treasury shares), will be transferred to HoldCo"; Siliconware was paid cash).
_NOT_HOLDERS = re.compile(r"option|warrant|restricted|\bRSU|\bPSU|award|rollover|roll-over|Rollover|preferred|Class\s+C\s+unit|Affiliated\s+Unitholder|Excluded|dividend|distribution|\bOP\s+units?\b|operating\s+partnership\s+units?|including\s+[^)]{0,40}treasury\s+shares", re.I)


def stock_terms(texts: list[str], cash: float | None = None) -> dict:
    """
    What the holders receive in stock, where the consideration sentence says:
    {"ratio": (value, passage) | None, "fixed": (dollars, passage) | None}.
    A ratio counts only within a sentence that gives the holders a right to
    receive it, and not one about options, awards, a rollover, a
    distribution or an earlier proposal; and only where the filing states it
    more than once, as it states its own terms (a rival's proposal recited
    once in the background is not this deal's consideration). A stock part
    fixed in dollars counts only beside the cash it is paid with ("(1)
    $1.73 in cash and (2) a fraction of a share ... dividing $1.27 by"): an
    all-stock election's dollar amount is the whole package, not a part.
    """
    ratios: Counter = Counter()
    rphrase: dict[float, str] = {}
    fixed: Counter = Counter()
    fphrase: dict[float, str] = {}
    for text in texts:
        for m in _FIXED_STOCK.finditer(text):
            v = float(m.group(1).replace(",", ""))
            lead = text[max(0, m.start() - 300):m.start()]
            if not _RECEIVE.search(lead) or _NOT_HOLDERS.search(lead[-160:]) or _PROPOSAL.search(lead[-200:]):
                continue
            if cash is None or not any(abs(float(p.group(1).replace(",", "")) - cash) <= 0.005 * cash for p in _PRICE.finditer(lead[-200:])):
                continue
            fixed[v] += 1
            fphrase.setdefault(v, re.sub(r"\s+", " ", text[max(0, m.start() - 140):m.end() + 60]).strip())
        for m in _RATIO.finditer(text):
            lead = text[max(0, m.start() - 220):m.start()]
            lead = lead[max(lead.rfind(". "), lead.rfind(";")) + 1:]
            if not _RECEIVE.search(lead) or _NOT_HOLDERS.search(lead) or _PROPOSAL.search(lead):
                continue
            v = float(m.group(1))
            if not 0.001 <= v <= 50 or v == 1.0:
                continue
            ratios[v] += 1
            rphrase.setdefault(v, re.sub(r"\s+", " ", text[max(0, m.start() - 160):m.end() + 60]).strip())
    ratios = Counter({v: n for v, n in ratios.items() if n >= 2})
    fixed = Counter({v: n for v, n in fixed.items() if n >= 2})
    ratio = (ratios.most_common(1)[0][0], rphrase[ratios.most_common(1)[0][0]]) if ratios else None
    fix = (fixed.most_common(1)[0][0], fphrase[fixed.most_common(1)[0][0]]) if fixed else None
    return {"ratio": ratio, "fixed": fix}


#: the whole package, by name: never the stock or cash part alone
_WHOLE = r"(?:merger|transaction|scheme|offer|per[\s-]share|total|aggregate|unit)\s+consideration"
#: a stated value of the whole package, each with its amount as group 1
_IMPLIED = [
    # "the merger consideration represented approximately $42.08 in value for each share"
    re.compile(r"\b" + _WHOLE + r"\s+represent(?:ed|s)\s+(?:approximately\s+)?" + _MONEY + r"\s+in\s+(?:implied\s+)?value\s+(?:for|per)\s+each", re.I),
    # "The consideration to be received by JPE Unitholders ... is valued at $8.63 per unit based on the closing price of AMID Common Units as of October 21, 2016"
    re.compile(r"\b(?:the\s+)?(?:" + _WHOLE + r"|consideration\s+to\s+be\s+received\s+by)\b[^.;$]{0,100}?\b(?:is|was|will\s+be)\s+valued\s+at\s+(?:approximately\s+)?" + _MONEY + r"\s+per\s+(?:share|unit|ADS)\b", re.I),
    # "the implied value of the unit consideration for each QRE common unit and Class B unit was $22.48"
    re.compile(r"implied\s+value\s+of\s+the\s+" + _WHOLE + r"(?:\s+(?:for|per)\s+each\s+[^$.;,]{0,60}?|\s+to\s+[^$.;,]{0,40}?)?\s+(?:was|is)\s+(?:approximately\s+)?" + _MONEY + r"(?!\s+million)", re.I),
    # "the implied value of the consideration payable per share of MPG common stock as of November 1, 2016 of $22.03"
    re.compile(r"implied\s+value\s+of\s+the\s+consideration\s+payable\s+per\s+share\s+of\s+[^$.;]{0,60}?\s+as\s+of\s+[A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4}\s+of\s+" + _MONEY, re.I),
    # "The implied value of the merger consideration at the offer price of $140 per share"
    re.compile(r"implied\s+value\s+of\s+the\s+" + _WHOLE + r"\s+at\s+the\s+offer\s+price\s+of\s+" + _MONEY, re.I),
    # "representing total merger consideration of approximately $140.00 per share": an example, never the tie
    re.compile(r"representing\s+(?:total|aggregate)\s+(?:\w+\s+)?consideration\s+of\s+(?:approximately\s+)?" + _MONEY + r"\s+per\s+(?:share|unit|ADS)\b", re.I),
]
#: the day a value is measured on, by the filing's own description of it
_REFERENCE_DAY = re.compile(r"last\s+(?:full\s+)?trading\s+(?:day|date)\s+(?:before|prior\s+to|preceding)\s+(?:the\s+)?(?:public\s+)?(?:announcement|execution|signing|disclosure)", re.I)
_PRACTICABLE = re.compile(r"practicable|prior\s+to\s+the\s+(?:date\s+of\s+)?(?:mailing|printing|filing)|date\s+of\s+this\s+(?:proxy|document|joint|information|prospectus|offer)", re.I)


def _sentence(text: str, start: int, end: int) -> str:
    """The sentence around text[start:end]: back to the last full stop or bullet, on to the next full stop."""
    before = text[max(0, start - 400):start]
    cut = max(before.rfind(". "), before.rfind("•"))
    after = text[end:end + 240]
    stop = re.search(r"\.\s+(?=[A-Z(“\"])|•", after)
    return before[cut + 1:] + text[start:end] + (after[: stop.start()] if stop else after)


def implied_values(texts: list[str]) -> list[dict]:
    """
    Every value of the whole package a filing states: {value, date, day,
    excerpt}, day being "reference" (the filing calls the date the last
    trading day before the announcement), "practicable" (the proxy's own date),
    "offer price" (stated as the agreed price itself, undated), or "dated".
    """
    out: list[dict] = []
    seen: set = set()
    for text in texts:
        for pat in _IMPLIED:
            for m in pat.finditer(text):
                try:
                    v = float(m.group(1).replace(",", ""))
                except ValueError:
                    continue
                if not 0.05 <= v <= 10_000:
                    continue
                sentence = _sentence(text, m.start(), m.end())
                # An adviser's illustration, or a value an earlier or rival
                # proposal carried, is not this deal's package.
                if (_ADVISER.search(sentence) and "offer price" not in m.group(0).lower()) or _PROPOSAL.search(sentence):
                    continue
                d = _date_in(sentence)
                if "offer price" in m.group(0).lower():
                    day = "offer price"
                elif _PRACTICABLE.search(sentence):
                    day = "practicable"
                elif _REFERENCE_DAY.search(sentence):
                    day = "reference"
                elif re.search(r"total\s+(?:\w+\s+)?consideration\s+of", m.group(0), re.I):
                    day = "example"
                else:
                    day = "dated" if d else "undated"
                key = (v, d, day)
                if key in seen:
                    continue
                seen.add(key)
                out.append({"value": v, "date": d, "day": day, "excerpt": re.sub(r"\s+", " ", sentence).strip()[:400]})
    return out


#: the filing's own sum: "calculated by using the last closing price of XING's
#: ordinary shares ... of US$1.68 as of September 7, 2010, multiplied by 1.9,
#: plus US$0.80"
_SUM = re.compile(
    r"closing\s+price\s+of\s+[^.;$]{0,120}?" + _MONEY + r"\s+(?:as\s+of|on)\s+" + _DATE + r",?\s+multiplied\s+by\s+(\d{1,2}(?:\.\d{1,5})?),?\s+plus\s+" + _MONEY,
    re.I,
)


def summed_values(texts: list[str]) -> list[dict]:
    """Packages the filing itself adds up from a stated price, its date, a ratio and the cash: {value, date, parts, excerpt}."""
    out: list[dict] = []
    for text in texts:
        for m in _SUM.finditer(text):
            price, ratio, cash = float(m.group(1).replace(",", "")), float(m.group(5)), float(m.group(6).replace(",", ""))
            when = iso_date(m.group(2), m.group(3), m.group(4))
            out.append({"value": round(ratio * price + cash, 4), "date": when, "parts": {"price": price, "ratio": ratio, "cash": cash}, "excerpt": re.sub(r"\s+", " ", text[max(0, m.start() - 200):m.end() + 20]).strip()[:400]})
    return out


_PER_ADS_AFTER = re.compile(r"^[^.;$]{0,30}?\bper\s+(?:ADS|American\s+Depositary\s+Share)\b", re.I)
_PER_SHARE_AFTER = re.compile(r"^[^.;$]{0,30}?\bper\s+(?:(?:Class\s+[A-Z]\s+)?(?:[Oo]rdinary\s+|[Cc]ommon\s+)?[Ss]hare|[Oo]rdinary\s+[Ss]hare)\b")
_PER_ADS_BEFORE = re.compile(r"Per\s+ADS\s+(?:Merger\s+)?Consideration\s+of\s*$", re.I)


def _quoted(texts: list[str], value: float) -> tuple[int, int, str | None, str | None]:
    """How often the filings quote `value` per ADS and per share, with a passage for each."""
    ads = share = 0
    ads_at = share_at = None
    for text in texts:
        for m in re.finditer(_MONEY, text):
            try:
                v = float(m.group(1).replace(",", ""))
            except ValueError:
                continue
            if abs(v - value) > 0.0005 * max(value, 1):
                continue
            after, before = text[m.end():m.end() + 60], text[max(0, m.start() - 40):m.start()]
            passage = re.sub(r"\s+", " ", text[max(0, m.start() - 80):m.end() + 60]).strip()
            if _PER_ADS_AFTER.search(after) or _PER_ADS_BEFORE.search(before):
                ads += 1
                ads_at = ads_at or passage
            elif _PER_SHARE_AFTER.search(after):
                share += 1
                share_at = share_at or passage
    return ads, share, ads_at, share_at


def _exact(v: float) -> float:
    """
    A price kept to eight significant figures, not four decimal places: a
    price per ADS over the ratio is a long quotient ($0.56 / 72 =
    $0.0077778 a share, which Zhangmen's filing states; four places would
    make it $0.0078, and $0.5616 an ADS), and times the ratio it must come
    back to the price per ADS.
    """
    return float(f"{v:.8g}")


def _stated_per_share(texts: list[str], value: float) -> tuple[float | None, str | None]:
    """The price the filings quote per share within half a percent of `value`, with its passage; (None, None) where none is."""
    for text in texts:
        for m in re.finditer(_MONEY, text):
            try:
                v = float(m.group(1).replace(",", ""))
            except ValueError:
                continue
            if abs(v - value) <= 0.005 * value and _PER_SHARE_AFTER.search(text[m.end():m.end() + 60]):
                return v, re.sub(r"\s+", " ", text[max(0, m.start() - 80):m.end() + 60]).strip()
    return None, None


def _stated_per_ads(texts: list[str], value: float) -> float | None:
    """The price the filings quote per ADS within half a cent of `value`, or None."""
    for text in texts:
        for m in re.finditer(_MONEY, text):
            try:
                v = float(m.group(1).replace(",", ""))
            except ValueError:
                continue
            if abs(v - value) <= 0.005 and (_PER_ADS_AFTER.search(text[m.end():m.end() + 60]) or _PER_ADS_BEFORE.search(text[max(0, m.start() - 40):m.start()])):
                return v
    return None


def offer_unit(texts: list[str], offer: float) -> tuple[str | None, str | None]:
    """'ADS' where the filings quote the offer per ADS more often than per share, 'share' the other way, None where they never say; with a passage."""
    ads, share, ads_at, share_at = _quoted(texts, offer)
    if ads > share:
        return "ADS", ads_at
    if share > ads:
        return "share", share_at
    return None, None


#: a total the filing states for cash paid with a dividend or a distribution:
#: "an aggregate transaction value to Company shareholders of $26.00 per
#: Share", "a total transaction value of $32.50 per share of Common Stock",
#: "The aggregate value to shareholders of approximately $10.74 per share"
_PACKAGE = re.compile(
    r"(?:aggregate|total)\s+(?:transaction\s+)?value\s+(?:to\s+(?:the\s+)?(?:Company\s+)?(?:share|stock)holders\s+)?(?:of\s+)?(?:approximately\s+)?" + _MONEY + r"\s+per\s+[Ss]hare",
    re.I,
)
_PAYOUT = re.compile(r"special\s+dividend|distribut(?:ed|ion)|spin-?off", re.I)


def payout_values(texts: list[str], offer: float) -> list[dict]:
    """
    Totals the filing states for the offer's cash with a special dividend or a
    distribution paid beside it: {value, payout, excerpt}. The sentence names
    the dividend or distribution, and the offer itself or the cash payment;
    the total is more than the cash and less than three times it; and an
    adviser's analysis is passed over.
    """
    out: list[dict] = []
    seen: set = set()
    for text in texts:
        for m in _PACKAGE.finditer(text):
            v = float(m.group(1).replace(",", ""))
            if not offer * 1.005 < v < offer * 3:
                continue
            sentence = _sentence(text, m.start(), m.end())
            if not _PAYOUT.search(sentence) or _ADVISER.search(sentence):
                continue
            names_cash = any(abs(float(p.group(1).replace(",", "")) - offer) <= 0.005 * offer for p in re.finditer(_MONEY, sentence)) or re.search(r"cash\s+payment|cash\s+consideration|in\s+cash", sentence, re.I)
            if not names_cash:
                continue
            # The dividend the sentence states, where it states one that makes up the difference.
            payout = next((float(p.group(1).replace(",", "")) for p in re.finditer(_MONEY, sentence) if abs(float(p.group(1).replace(",", "")) - (v - offer)) <= 0.011), None)
            if v in seen:
                continue
            seen.add(v)
            out.append({"value": v, "payout": payout, "excerpt": re.sub(r"\s+", " ", sentence).strip()[:400]})
    return out


def read_offer(texts: list[str], offer: float | None, offer_basis: str | None, announced: str | None = None, original: str | None = None) -> dict:
    """
    The whole offer for one deal, each part with its passage:

      components  every part read: the cash, the ADS ratio, the stock (an
                  exchange ratio or a fixed dollar amount), each value of the
                  package the filing states, the filing's own sums
      stock       whether the consideration includes stock
      implied     the whole offer per share (or unit) a premium is tied to
      method      cash, stated, or computed from stated components
      date        the day the value is measured on, where it has one
      adsRatio, perAds   the ADS ratio and the offer per ADS, where stated
      perShare    where the offer read is per ADS: the per-share price the
                  filing states beside it, (value, passage)
      ties        what a premium may be tied to, as (value, unit) pairs
      unresolved  why there is nothing to tie to, where there is not
    """
    out: dict = {"components": [], "stock": False, "implied": None, "method": None, "date": None, "basis": None, "adsRatio": None, "perAds": None, "perShare": None, "ties": [], "unresolved": None}
    if offer is None:
        return out
    per_ads = bool(offer_basis and re.search(r"per\s+ADS\b|per\s+American\s+Depositary", offer_basis, re.I))
    unit, uphrase = offer_unit(texts, offer)
    if not per_ads and unit == "ADS":
        per_ads, offer_basis = True, uphrase
    out["components"].append({"part": "cash", "value": offer, "per": "ADS" if per_ads else "share", "excerpt": offer_basis})
    ratio, rphrase = ads_ratio(texts)
    if ratio:
        out["adsRatio"] = ratio
        out["components"].append({"part": "ADS ratio", "value": ratio, "excerpt": rphrase})
    if per_ads and ratio:
        # The per-share price is the one the filing states beside the per-ADS
        # one; the ADS price over the stated ratio otherwise, and it says so.
        # The stated figure is kept as stated, where times the ratio it comes
        # back to the price per ADS to half a cent: LAIX's US$0.1357 a share
        # (x 14 = $1.8998, for US$1.90 an ADS) is what the filing pays, though
        # $1.90 / 14 is $0.13571429. A rounded figure that does not come back
        # (Youku's $1.53 x 18 = $27.54, for $27.60 an ADS) is not the price.
        each = _exact(offer / ratio)
        stated_each, at = _stated_per_share(texts, each)
        if stated_each is not None and abs(stated_each * ratio - offer) > 0.005:
            stated_each, at = None, None
        out["perShare"] = (stated_each, at) if stated_each is not None else (each, f"${offer:,.4g} per ADS / {ratio:g} shares per ADS, as the filing states the ratio")
        each = out["perShare"][0]
        out["components"].append({"part": "cash", "value": each, "per": "share", "excerpt": out["perShare"][1]})
    terms = stock_terms(texts, None if per_ads else offer)
    stated = implied_values(texts)
    sums = summed_values(texts)
    if terms["ratio"]:
        out["components"].append({"part": "stock", "exchangeRatio": terms["ratio"][0], "excerpt": terms["ratio"][1]})
    if terms["fixed"]:
        out["components"].append({"part": "stock", "fixedValue": terms["fixed"][0], "excerpt": terms["fixed"][1]})
    for s in stated:
        out["components"].append({"part": "stated value", "value": s["value"], "date": s["date"], "day": s["day"], "excerpt": s["excerpt"]})
    for s in sums:
        out["components"].append({"part": "filing's sum", "value": s["value"], "date": s["date"], "parts": s["parts"], "excerpt": s["excerpt"]})
    stock = bool(terms["ratio"] or terms["fixed"] or sums or any(mixed_consideration(t) for t in texts))
    out["stock"] = stock

    def near(day: str | None) -> bool:
        if not day:
            return False
        for anchor in (announced, original):
            if anchor:
                gap = (date.fromisoformat(anchor) - date.fromisoformat(day)).days
                if -5 <= gap <= 120:
                    return True
        return False

    payouts = payout_values(texts, offer) if not stock and not per_ads else []
    for s in payouts:
        out["components"].append({"part": "with payout", "value": s["value"], "payout": s["payout"], "excerpt": s["excerpt"]})
    if not stock and payouts:
        best = payouts[0]
        out["implied"], out["method"] = best["value"], "stated"
        paid = f"${best['payout']:,.2f} paid beside it" if best["payout"] else "a distribution paid beside it"
        out["basis"] = f"${offer:,.2f} cash plus {paid}, which the filing values together at ${best['value']:,.2f}: {best['excerpt']}"
    elif not stock and per_ads and not ratio:
        # Quoted per ADS with no ratio stated: the offer ties per ADS only.
        out["perAds"] = offer
        out["basis"] = "the cash per ADS is the whole consideration; the filing states no ADS ratio, so there is no per-share price"
        out["ties"] = [(offer, "ADS")]
        return out
    elif not stock:
        out["implied"], out["method"] = (out["perShare"][0] if out["perShare"] else offer), "cash"
        out["basis"] = "the per-share cash is the whole consideration"
    else:
        # The package's value on the reference day, as the filing states it;
        # then a value it states as the agreed price; then one it states for
        # a date near the agreement; then the filing's own sum on such a date;
        # then a stock part fixed in dollars added to the cash.
        # A package with stock is worth more than its cash: a smaller value
        # is a part of it (the stock alone, a dividend), not the whole.
        whole = [s for s in stated if per_ads or s["value"] > offer * 1.005]
        ranked = [s for s in whole if s["day"] == "reference" and (near(s["date"]) or not announced)]
        ranked += [s for s in whole if s["day"] == "offer price"]
        ranked += [s for s in whole if s["day"] == "dated" and near(s["date"])]
        if ranked:
            best = ranked[0]
            out["implied"], out["method"], out["date"] = best["value"], "stated", best["date"]
            out["basis"] = f"the value of the whole consideration as the filing states it{' on ' + best['date'] if best['date'] else ''}: {best['excerpt']}"
        else:
            summed = [s for s in sums if near(s["date"]) or not announced]
            if summed:
                s = summed[0]
                out["implied"], out["method"], out["date"] = s["value"], "computed from stated components", s["date"]
                p = s["parts"]
                out["basis"] = f"{p['ratio']} x ${p['price']:,.2f} (the acquirer's close on {s['date']}, as stated) + ${p['cash']:,.2f} cash, as the filing adds it: {s['excerpt']}"
            elif terms["fixed"] and not per_ads and not terms["ratio"]:
                fixed = terms["fixed"][0]
                out["implied"], out["method"] = round(offer + fixed, 4), "computed from stated components"
                out["basis"] = f"${offer:,.2f} cash + ${fixed:,.2f} in stock, a dollar amount the agreement converts into shares at the acquirer's average price: {terms['fixed'][1]}"
            else:
                practicable = [s for s in stated if s["day"] in ("practicable", "example")]
                out["unresolved"] = "the consideration includes stock and the filing states its value on no day near the agreement" + (
                    f" (only at {practicable[0]['date'] or 'the proxy date'}: ${practicable[0]['value']:,.2f})" if practicable else "") + ", nor parts that add up to it"
    if out["implied"] is not None:
        out["implied"] = _exact(out["implied"])
        ties = [(out["implied"], "share")]
        if ratio:
            # The price per ADS the filing states, where it states the
            # product ("US$1.90 in cash per ADS" beside "US$0.1357 ... per
            # Ordinary Share" and fourteen shares an ADS: LAIX); the product
            # otherwise. $0.1357 x 14 is $1.8998, a figure no filing gave.
            # An offer read per ADS is its own price per ADS.
            product = out["implied"] * ratio
            out["perAds"] = offer if per_ads and not stock else (_stated_per_ads(texts, product) or round(product, 4))
            ties.append((out["perAds"], "ADS"))
        out["ties"] = ties
    return out


# ── the premiums ─────────────────────────────────────────────────────────────
#
# A merger proxy states its deal's premium in its own words: "a premium of
# approximately 32% over the closing stock price of $30.22 of Juniper common
# stock on January 8, 2024, the last trading day prior to the approval of the
# Merger". That sentence is the deal's definition of the unaffected price, and
# when it names the price the price is read, never worked back from a rounded
# percentage.
#
# The same document states other premiums that are not this deal's:
#
#   the advisers'   "a reference range of illustrative premiums of 20% to 50%",
#                   a median of comparable transactions: about other deals
#   earlier bids    the background recites every proposal before the one
#                   agreed, each with its premium to a close weeks earlier
#
# So each statement is read with the clause after it (the basis, the price and
# the date it measures against) and the sentence before it (who is speaking).
# An adviser's analysis is set aside outright. An earlier proposal is set aside
# where it names a different price or a reference date too far from the
# agreement, and otherwise ranks below the statement the proxy itself calls
# unaffected. This is the same rule lib/finance-os/providers/sec-proxy-premiums.ts
# applies in the site repository, so the two read a proxy alike.

_PRICE = re.compile(r"\$\s?(\d{1,4}(?:,\d{3})*(?:\.\d{1,4})?)")


def _targets(offer) -> list[float]:
    """The offer as a list of the values it may be quoted at (per share, per ADS)."""
    if offer is None:
        return []
    if isinstance(offer, (int, float)):
        return [float(offer)] if offer else []
    return [float(o) for o in offer if o]


def _refused(before: str, offer) -> bool:
    """Whether the words leading into a premium name a per-share price other than the one agreed (`offer` one value or several)."""
    targets = _targets(offer)
    if not targets:
        return False
    # Only the statement's own words: a bullet list states the unaffected
    # price in its first item, and the next item is not "another price".
    head = before[max(before.rfind(". "), before.rfind("•"), before.rfind(";")) + 1:]
    # A statement that names the agreed offer itself and restates it ("US$3.50
    # per ADS or US$0.70 per Share") is the deal's own, whatever else it names.
    for m in _PRICE.finditer(head):
        try:
            if any(abs(float(m.group(1).replace(",", "")) - t) <= 0.005 * t for t in targets):
                return False
        except ValueError:
            continue
    for m in _PRICE.finditer(head):
        try:
            v = float(m.group(1).replace(",", ""))
        except ValueError:
            continue
        if re.match(r"\s*(?:million|billion|thousand)", head[m.end():m.end() + 10], re.I):
            continue
        # A reference price ("closing stock price of $32.08") and a payment
        # beside the cash ("up to $3.00 per DAP Right", a CVR) are not a
        # different offer for the share.
        near = head[max(0, m.start() - 60):m.end() + 30]
        if re.search(r"clos|unaffected|undisturbed|volume[\s-]*weighted|vwap|average|52[\s-]*week|\bhigh\b", head[max(0, m.start() - 60):m.start()], re.I):
            continue
        if re.search(r"per\s+(?:\w+\s+){0,2}(?:Right|CVR|warrant|unit)\b|contingent value", near, re.I):
            continue
        if 0.05 <= v <= 10_000 and all(abs(v - t) > 0.01 * t for t in targets):
            return True
    return False


#: an adviser speaking about other deals or a range, never this deal's premium
_ADVISER = re.compile(
    r"illustrative|percentile|\bmedian\b|\bmean\b|reference range|range of|comparable|selected (?:precedent |public |take-private )?transactions"
    r"|precedent|premiums? paid analysis|premia paid analysis|implied (?:equity|per share|enterprise)|\bapplied\b",
    re.I,
)
#: the terms of another instrument, priced as a premium to the share price and
#: never the deal's: a capped call's cap ("subject to a cap representing a
#: price per share of $31.45, an approximately 75.0% premium over our share
#: price of $17.97": Nabors' exchangeable notes, in TESCO's proxy), a
#: convertible's conversion price ("an initial conversion price reflecting a
#: 15% premium to the VWAP"), a warrant's exercise or strike price ("an
#: exercise price equal to the greater of (a) a 20% premium on the 30-day VWAP")
_INSTRUMENT = re.compile(
    r"\bcapped\s+calls?\b|\bcap\s+price\b|\b(?:subject\s+to\s+)?an?\s+(?:cap|ceiling|limit)\s+(?:representing|of|equal\s+to|at)\b"
    r"|\b(?:conversion|exercise|strike)\s+price\b|\bconversion\s+premium\b",
    re.I,
)
#: a proposal before the one agreed: ranked below the agreed deal's own statement
_PROPOSAL = re.compile(r"\bproposal\b|counterproposal|counter-proposal|indication of interest|\bbid\b|\bpreliminary\b|non-binding", re.I)
#: the proxy's own words for the last price before the news
_UNAFFECTED = re.compile(
    r"unaffected|undisturbed|last\s+(?:full\s+)?trading\s+day\s+(?:prior\s+to|before)|latest\s+(?:unaffected\s+)?trading\s+day\s+prior"
    # the close before the buyer first approached: "the market closing price
    # prior to Parent's initial offer made on May 24, 2024" (Martin Midstream)
    r"|prior\s+to\s+[^.;%]{0,40}?\b(?:initial|first)\s+(?:offer|proposal|approach)",
    re.I,
)
#: a percentage that is a premium: the word is beside it
_PCT = re.compile(r"(?<![\d.$])(\d{1,3}(?:\.\d+)?)\s?(?:%|percent\b)")
#: what a premium is measured against, near the figure
_REFERENCE = re.compile(
    r"\b(?:over|to|above|relative\s+to|compared\s+(?:to|with)|based\s+on|on)\b[^%;]{0,110}?"
    r"(?:unaffected|undisturbed|closing|close\b|last\s+(?:reported\s+)?(?:sale|trade|trading)|trading\s+(?:day|period)|"
    r"volume[\s-]*weighted|vwap|52[\s-]*week|fifty[\s-]two[\s-]week|highest|\bhigh\b|average|share\s+price|stock\s+price|price\s+per\s+share|market\s+price)",
    re.I,
)
#: where one statement ends and the next begins: a bullet, a semicolon, a full
#: stop, a numbered item, or the next premium in a list ("..., and a premium of
#: 15.2% over ...", "34% to the unaffected close, 26% to the 30-day VWAP")
_STOP = re.compile(
    r"[;•]|\.\s+(?=[A-Z(“\"])|\s\((?:i{1,3}|iv|v|vi|\d)\)\s"
    r"|,?\s+(?:and\s+)?(?:an?\s+)?premiums?\s+of\b"
    r"|,?\s+(?:and\s+)?(?:an?\s+)?(?:approximately\s+|about\s+)?\d{1,3}(?:\.\d+)?\s?(?:%|percent)\s+(?:premium\b|to\b|over\b|above\b)"
)


def _clause(text: str, at: int) -> str:
    """The words from a premium figure to the end of its own statement: the next statement, bullet, semicolon or full stop."""
    tail = text[at:at + 340]
    m = _STOP.search(tail, 6)
    return tail[: m.start()] if m else tail


def _lead(text: str, at: int) -> str:
    """The sentence leading into a premium figure, back to the last full stop or bullet."""
    before = text[max(0, at - 320):at]
    cut = max(before.rfind(". "), before.rfind("•"), before.rfind("\n"))
    return before[cut + 1:]


#: the agreement's defined term for its own price, beside a premium: "The
#: Merger Consideration also represents a premium of approximately 4%"
_AGREED = re.compile(r"\b(?:Merger|Offer|Per\s+Share|Transaction|Cash)\s+(?:Consideration|Price)\b")


_LIST_PCT = re.compile(r"\d{1,3}(?:\.\d+)?\s?%")


def _respectively(text: str, at: int) -> tuple[str, str] | None:
    """
    The window of one figure in a "respectively" list: "premiums of
    approximately 57%, 48% and 44% relative to the 30-, 60- and 90-day,
    respectively, volume-weighted average prices" gives the 57% the 30-day
    VWAP. None where the figure is not in such a list or the windows do not
    pair one to one with the figures.
    """
    start = at
    while True:
        m = re.search(r"(\d{1,3}(?:\.\d+)?\s?%)\s*,?\s*(?:and\s+)?$", text[max(0, start - 24):start])
        if not m:
            break
        start = max(0, start - 24) + m.start(1)
    tail = text[start:start + 260]
    run = re.match(r"(?:\d{1,3}(?:\.\d+)?\s?%\s*,?\s*(?:and\s+)?)+", tail)
    if not run:
        return None
    figures = _LIST_PCT.findall(run.group(0))
    rest = tail[run.end():]
    if len(figures) < 2 or not re.search(r"\brespectively\b", rest[:160], re.I):
        return None
    w = re.search(r"((?:\d{1,3}\s*-?\s*,?\s*(?:and\s+)?){2,})[\s-]*(?:trading[\s-]*|calendar[\s-]*)?(day|week|month)", rest[:160], re.I)
    if not w:
        return None
    windows = re.findall(r"\d{1,3}", w.group(1))
    if len(windows) != len(figures):
        return None
    index = len(_LIST_PCT.findall(text[start:at]))
    if index >= len(windows):
        return None
    basis = "vwap" if re.search(r"volume[\s-]*weighted|vwap", rest[:220], re.I) else "other"
    return basis, f"{windows[index]}-{w.group(2).lower()}"


def _basis(clause: str) -> tuple[str, str | None]:
    """What a premium is measured against: close, vwap (with its window), high, or other."""
    w = clause.lower()
    if re.search(r"volume[\s-]*weighted|vwap", w):
        m = re.search(r"(\d{1,3}|one|two|three|six|twelve|thirty|sixty|ninety)\s*(?:\(\d{1,3}\)\s*)?[\s-]*(?:consecutive[\s-]*)?(?:trading[\s-]*|calendar[\s-]*)?(day|week|month|year)", w)
        if not m:
            return "vwap", None
        words = {"one": "1", "two": "2", "three": "3", "six": "6", "twelve": "12", "thirty": "30", "sixty": "60", "ninety": "90"}
        return "vwap", f"{words.get(m.group(1), m.group(1))}-{m.group(2)}"
    if re.search(r"52[\s-]*week|fifty[\s-]two[\s-]week|highest|\bhigh\b|twelve[\s-]month|\bltm\b", w):
        # A premium to the period's low is quoted beside the one to its high
        # and is not a premium to the high.
        if re.search(r"\blow\b|lowest", w) and not re.search(r"highest|\bhigh\b", w):
            return "other", None
        # Nor is a premium to the average over twelve months (Rock of Ages:
        # 84% to the average close, beside 44% to the highest), or to the
        # high end of a proposal's range (Cornerstone), a premium to the high.
        peak = r"52[\s-]*week|fifty[\s-]two[\s-]week|highest|\bhigh\b(?!\s+end)"
        if re.search(r"\bhigh\s+end\b|average", w) and not re.search(peak, w):
            return "other", None
        return "high", None
    if re.search(r"average", w):
        return "other", None
    if re.search(r"closing|close\b|unaffected|undisturbed|last\s+(?:reported\s+)?(?:sale|trade|trading)|share\s+price|stock\s+price|market\s+price|price\s+per\s+share", w):
        return "close", None
    return "other", None


def _price_in(clause: str, offer, premium: float | None = None) -> float | None:
    """
    The reference price a premium clause names, never the offer itself. A
    small premium puts the reference within half a percent of the offer
    (Press Ganey's 0.4% is $40.50 over $40.33), so a price that near the offer
    is still the reference where it reproduces the stated premium, and is the
    offer restated where it does not.
    """
    for m in _PRICE.finditer(clause):
        try:
            v = float(m.group(1).replace(",", ""))
        except ValueError:
            continue
        if re.match(r"\s*(?:million|billion|thousand)", clause[m.end():m.end() + 10], re.I):
            continue
        if not 0.05 <= v <= 10_000:
            continue
        near = [t for t in _targets(offer) if abs(v - t) <= 0.005 * t]
        if near:
            t = near[0]
            if premium is None or abs(v - t) < 0.005 or abs((t / v - 1) - premium) > 0.002:
                continue
        return v
    return None


def _date_in(clause: str) -> str | None:
    m = re.search(_DATE, clause)
    return iso_date(m.group(1), m.group(2), m.group(3)) if m else None


#: days a 52-week high may sit before its reference date: the high is reached
#: somewhere inside the year that ends on the reference, so its own date says
#: nothing about how near the reference is to the agreement
HIGH_REACH_DAYS = 372

#: how far offer / reference price - 1 may sit from a stated premium, in
#: points, before the statement is taken to measure another price: rounding
#: of the percentage and of the price, never a different bid
PREMIUM_FIT = 0.02


def premium_statements(text: str, offer: float | None = None, announced: str | None = None, cash_only: bool = True, original: str | None = None, ties: list[tuple[float, str]] | None = None, tie_date: str | None = None) -> tuple[list[dict], list[dict]]:
    """
    Every premium the document states for its own deal, and every one set
    aside with the reason. A statement is
    {basis, window, premium, price, date, unaffected, proposal, excerpt}.

    The window rule is one rule, applied to the date each statement is
    measured to:

      - a close or VWAP statement is measured to the date it names;
      - a 52-week high names the day the high was reached, which can be any
        day of the year ending on the reference, so it is measured to that
        year (HIGH_REACH_DAYS) rather than to its own date;
      - a statement measured to the same day as a statement the filing calls
        unaffected shares that statement's reference, so it is kept whatever
        its own wording (R1 RCM's 39% to the 30-day VWAP ending on the
        23 February unaffected day, beside its 29% to that close);
      - a revised deal's statements may be measured to the original
        agreement (`original`): iRobot's $51.75 is 25% over the 30-day VWAP
        as of the 4 August 2022 agreement.

    A statement is tied to the whole offer (read_offer) where `ties` gives
    it, as (value, unit) pairs, per share and per ADS: that is what a premium
    is measured on, cash and stock alike. Without `ties`, an all-cash deal's
    per-share cash is the offer, and a deal with stock has none to tie to.
    A package with stock is worth what the acquirer's shares are worth on the
    day, so its statements are held to it only on the day its value is
    stated (`tie_date`): TWC's 17% is measured with Comcast's price of 11
    February 2014, the $158.82 with that of 12 February. And only an all-cash
    deal's lead-in is read for another price: a stock deal's names the
    acquirer's ("based on the $23.69 closing price per share of Taylor
    Morrison common stock").
    """
    if ties is None:
        ties = [(offer, "share")] if (offer and cash_only) else []
    targets = [t for t, _ in ties]
    # The figures the filing may name as this deal's own: the whole offer and
    # the cash part of it ("$27.30 in cash and 0.3885 of an Aetna common share
    # ... represents a premium of"), never a different bid.
    named = targets + ([offer] if offer and all(abs(offer - t) > 0.005 * t for t in targets) else [])
    kept: list[dict] = []
    aside: list[dict] = []
    #: statements outside the window on their own wording, kept if another
    #: statement the filing calls unaffected names the same day
    pending: list[tuple[dict, str]] = []
    seen: set = set()
    for m in _PCT.finditer(text):
        at = m.start()
        near_before = text[max(0, at - 60):at].lower()
        near_after = text[m.end():m.end() + 14].lower()
        # The word is beside the figure, or the figure is an item of a list a
        # premium sentence opens ("represents a premium of: • approximately
        # 32% over ...; • approximately 16% over the 52-week high").
        listed = text[max(0, at - 400):at]
        listed = listed[listed.rfind(". ") + 1:]
        if not (re.search(r"premi(?:um|a)", near_before) or re.match(r"\s*premium", near_after) or re.search(r"premi(?:um|a)\s+of\s*:|premia\s+of\b", listed, re.I)):
            continue
        # "of 20% to 50%": a range is an analysis, never a deal's premium.
        # "Between 20% and 50%" is a range too; "57%, 48% and 44%" is a list.
        between = re.search(r"between\s+(?:approximately\s+)?$", text[max(0, at - 30):at], re.I)
        if re.match(r"\s*(?:to|-|–)\s*\d{1,3}(?:\.\d+)?\s?(?:%|percent)", text[m.end():m.end() + 16]) or (between and re.match(r"\s*and\s*\d{1,3}(?:\.\d+)?\s?(?:%|percent)", text[m.end():m.end() + 16])) or re.search(r"\d\s?(?:%|percent)?\)?\s*(?:to|-|–)\s*(?:an?\s+)?$", text[max(0, at - 16):at]) or re.search(r"between\s+(?:approximately\s+)?\d{1,3}(?:\.\d+)?\s?(?:%|percent)?\s*and\s*$", text[max(0, at - 40):at], re.I):
            # Including a negative lower bound in parentheses: Cymer's "from a
            # (25.0%) to a 25.0% premium to the $52.81 closing price of ASML".
            aside.append({"reason": "a range", "excerpt": re.sub(r"\s+", " ", text[max(0, at - 80):at + 120]).strip()})
            continue
        # "with premia greater than 200% or less than 0%" is a screen's bound.
        if re.search(r"(?:greater|less|more|fewer)\s+than\s*$|in\s+excess\s+of\s*$|at\s+least\s*$|up\s+to\s*$", text[max(0, at - 20):at], re.I):
            aside.append({"reason": "a bound, not a premium", "excerpt": re.sub(r"\s+", " ", text[max(0, at - 80):at + 120]).strip()})
            continue
        clause = _clause(text, at)
        if not _REFERENCE.search(clause[:200]):
            continue
        try:
            v = round(float(m.group(1)) / 100, 4)
        except ValueError:
            continue
        if not 0 < v <= 3.0:
            continue
        lead = _lead(text, at)
        excerpt = re.sub(r"\s+", " ", (lead[-140:] + clause)).strip()[:320]
        if _ADVISER.search(lead) or _ADVISER.search(clause):
            aside.append({"reason": "a financial adviser's analysis", "excerpt": excerpt})
            continue
        # A cap, a conversion price or an exercise price is set at a premium to
        # the share price: it is the price of another instrument, not the
        # premium the deal pays (TESCO's proxy carries Nabors' capped calls at
        # 75%; the deal's own premium is the 19% beside its $4.62 a share).
        # The sentence is read back to its full stop, across the line breaks a
        # wrapped paragraph carries: one of TESCO's five copies breaks the line
        # between "a price per share of $31.45, an" and "approximately 75.0%".
        said = text[max(0, at - 240):at]
        said = said[max(said.rfind(". "), said.rfind("•")) + 1:]
        if _INSTRUMENT.search(said):
            aside.append({"reason": "the terms of another instrument (a cap, a conversion or exercise price), not the deal's premium", "excerpt": re.sub(r"\s+", " ", said[-140:] + clause).strip()[:320]})
            continue
        basis, window = _respectively(text, at) or _basis(clause)
        price = _price_in(clause, targets or offer, v)
        when = _date_in(clause)
        gap = None
        outside = None
        # The proxy's own words for the unaffected day often follow the first
        # figure of a list ("... on October 12, 2012 and approximately 49.2%
        # ... the last trading day prior to the Company's announcement").
        own = bool(_UNAFFECTED.search(clause) or _UNAFFECTED.search(text[at:at + 420]) or _UNAFFECTED.search(lead[-160:])) and not _PROPOSAL.search(lead)
        # Reaching back beyond four months needs the statement's own words:
        # wording in the next sentence may describe a different date
        # (ChyronHego's 230% is to a close before an earlier merger).
        strict = bool(_UNAFFECTED.search(clause) or _UNAFFECTED.search(lead[-160:])) and not _PROPOSAL.search(lead)
        if announced and when:
            gap = (date.fromisoformat(announced) - date.fromisoformat(when)).days
            # A premium is measured to the last trading day before the news.
            # The proxy says which day that is, and it can be months before
            # the agreement: the day before a leak, a stake disclosed, the
            # first proposal (Nordstrom's is nine months earlier). A statement
            # the proxy itself calls unaffected may reach back two years; any
            # other may reach back four months; a date after the agreement is
            # never this deal's reference.
            reach = (730 if strict else 120) + (HIGH_REACH_DAYS if basis == "high" else 0)
            within = -5 <= gap <= reach
            if not within and original:
                g0 = (date.fromisoformat(original) - date.fromisoformat(when)).days
                within = -5 <= g0 <= reach
            if not within:
                outside = f"measured to {when}, not near the agreement of {announced}"
        # A different per-share figure leading into the premium is an earlier
        # bid, for an all-cash deal. Where the consideration includes stock,
        # the sentence states the value of the whole package ("valued at
        # $30.00 per Share"), which is never the cash part alone.
        if targets and cash_only and _refused(text[max(0, at - 220):at], named):
            aside.append({"reason": "names a per-share price other than the one agreed", "excerpt": excerpt})
            continue
        names_offer = bool(_AGREED.search(lead)) or any(abs(float(p.group(1).replace(",", "")) - t) <= 0.005 * t for p in _PRICE.finditer(lead[-200:]) if p.group(1).replace(",", "").replace(".", "").isdigit() for t in named)
        # A premium is the deal's only at the deal's price. Where the
        # statement gives its reference price, the price it measures is that
        # reference plus the premium, and for an all-cash deal that must be the
        # final offer to within rounding (two points, the tolerance the
        # unaffected price is held to below). Baldwin's "That price
        # represented an approximately 83% premium to ... $17.33" is the
        # Sponsors' $31.75 Round 2 bid; the $32.50 agreed is 87.5%. A
        # statement that names the agreed consideration itself stands.
        same_day = cash_only or tie_date is None or when == tie_date
        if targets and price and not names_offer and same_day and all(abs((t / price - 1) - v) > PREMIUM_FIT for t in targets):
            t, unit = min(ties, key=lambda tu: abs((tu[0] / price - 1) - v))
            a = "an" if unit == "ADS" else "a"
            aside.append({"reason": f"measures ${price * (1 + v):,.2f} {a} {unit} (${price:,.2f} plus {v:.1%}), not the offer of ${t:,.2f} {a} {unit}: another price's premium", "excerpt": excerpt})
            continue
        row = {
            "basis": basis,
            "window": window,
            "premium": v,
            "price": price,
            "date": when,
            # Days from the reference date to the agreement, where both are known.
            "gap": gap,
            "unaffected": bool(_UNAFFECTED.search(clause) or _UNAFFECTED.search(lead[-160:])),
            # The filing's own defined term ("the unaffected closing price"),
            # over a description of the day ("the last trading day before").
            "defined": bool(re.search(r"unaffected|undisturbed", clause + lead[-160:], re.I)),
            "proposal": bool(_PROPOSAL.search(lead)),
            # The statement names the agreed offer itself ("The $2.06 per share
            # proposal represented ..."): the deal's own, among the background's.
            "namesOffer": names_offer,
            "excerpt": excerpt,
        }
        if outside:
            pending.append((row, outside))
            continue
        key = (basis, window, v, price, when)
        if key in seen:
            for k in kept:
                if (k["basis"], k["window"], k["premium"], k["price"], k["date"]) == key:
                    k["count"] = k.get("count", 1) + 1
            continue
        seen.add(key)
        kept.append(row)
    # A statement outside the window on its own wording is kept where a
    # statement the filing calls unaffected is measured to the same day: the
    # two share one reference, and the window is the reference's, not the
    # wording's (see above).
    reference = {k["date"] for k in kept if k.get("date") and k["unaffected"] and not k["proposal"]}
    for row, reason in pending:
        key = (row["basis"], row["window"], row["premium"], row["price"], row["date"])
        if row.get("date") in reference and key not in seen:
            seen.add(key)
            kept.append({**row, "sharesReference": True})
        elif row.get("date") not in reference:
            aside.append({"reason": reason, "excerpt": row["excerpt"]})
    return kept, aside


def _score(s: dict) -> tuple:
    """
    Which of several statements of one basis is the deal's own: not a
    proposal, naming the agreed offer, unaffected, with a price, with a date;
    then the most repeated, then the most precise ("15.3%" over "15%"), then
    the first met.
    """
    precise = len(f"{s['premium']:.6f}".rstrip("0").split(".")[1]) if "." in f"{s['premium']:.6f}".rstrip("0") else 0
    return (
        (0 if s["proposal"] else 3) + (2 if s.get("namesOffer") else 0) + (2 if s["unaffected"] else 0) + (1 if s.get("defined") else 0) + (1 if s.get("price") else 0) + (1 if s.get("date") else 0),
        s.get("count", 1),
        # Among equals, the close nearest before the agreement: the background
        # quotes earlier closes for earlier exchange ratios (Hess: 10.2% to
        # 29 September against the 4.9% to 20 October, the last day before).
        -s["gap"] if s.get("gap") is not None and s["gap"] >= 0 else -10_000,
        precise,
    )


def _stated_price_on(text: str, when: str, offer) -> tuple[float | None, str | None]:
    """A closing price the document states for the unaffected date, wherever it says it: '... closing price ... on August 2, 2024 of $62.98'."""
    best = None
    for m in re.finditer(_DATE, text):
        if iso_date(m.group(1), m.group(2), m.group(3)) != when:
            continue
        win = text[max(0, m.start() - 160):m.end() + 60]
        if not re.search(r"clos|unaffected|undisturbed|share price|stock price", win, re.I):
            continue
        # The same date ends a 52-week period, a VWAP and an average as often
        # as it is a close (Press Ganey: "the highest closing price ... over
        # the 52-week period ended August 8, 2016 of $40.97"). Only the
        # statement's own words before the date count: the clause it is in.
        own = text[max(0, m.start() - 160):m.start()]
        own = own[max(own.rfind(";"), own.rfind("•"), own.rfind(". ")) + 1:]
        # An adviser's range of illustrative prices "based on the closing
        # share prices ... on October 23, 2019" is no close either (Aircastle).
        if re.search(r"highest|\bhigh\b|52[\s-]*week|fifty[\s-]two[\s-]week|volume[\s-]*weighted|vwap|average|\blow\b|lowest|illustrative\s+range|range\s+of\s+(?:illustrative\s+|implied\s+)?(?:prices|values)", own, re.I):
            continue
        # The price beside the date, after it ("on August 2, 2024 of $62.98")
        # or just before it ("of $39.31 as of April 1, 2022").
        for p in list(_PRICE.finditer(text[m.end():m.end() + 40])) + list(_PRICE.finditer(text[max(0, m.start() - 40):m.start()])):
            try:
                v = float(p.group(1).replace(",", ""))
            except ValueError:
                continue
            # The offer restated is not the close; a close within half a
            # percent of it is, for a small premium, and the caller checks the
            # price against the stated premium before it keeps it.
            if 0.05 <= v <= 10_000 and not any(abs(v - t) < 0.005 for t in _targets(offer)):
                best = (v, re.sub(r"\s+", " ", win + text[m.end():m.end() + 60]).strip()[:300])
                break
        if best:
            return best
    return None, None


def choose_premiums(statements: list[dict], offer: float | None, cash_only: bool, texts: list[str] | None = None, ties: list[tuple[float, str]] | None = None) -> dict:
    """
    The deal's premiums from every statement kept across its documents:

      premium1Day        the premium to the unaffected close
      premium30DayVwap   to the 30-trading-day VWAP
      premium52WeekHigh  to the 52-week high
      unaffectedPriceStated, unaffectedDate, unaffectedPriceBasis
                         the reference price and date as the document states them

    The price is read where the document states it, beside the premium or for
    the same date elsewhere, and kept only where offer / price - 1 agrees with
    the stated premium to within two points; a cash-and-stock deal's per-share
    cash is not the whole consideration, so there the stated premium stands
    alone. Nothing is worked back from a percentage here: finalize does that,
    for an all-cash deal only, and says it did.

    With `ties` (read_offer's whole offer, per share and per ADS) the price
    is checked against those instead, whatever the consideration, and
    unaffectedPricePer says which unit the stated price is in.
    """
    out: dict = {"premium1Day": None, "premium30DayVwap": None, "premium52WeekHigh": None, "unaffectedPriceStated": None, "unaffectedPricePer": None, "unaffectedDate": None, "unaffectedPriceBasis": None, "premiumBasis": [], "premiumPreAnnouncement": None, "premiumPreAnnouncementDate": None}
    if ties is None:
        ties = [(offer, "share")] if (offer and cash_only) else []
    # A statement admitted only because it is measured to the same day as a
    # kept unaffected statement (sharesReference) fills a basis the window
    # left empty; it never displaces one inside the window (Distribution
    # Solutions: the 14.2% to the 30-day VWAP stands, not a misfiled 81%).
    pick = lambda xs: max(xs, key=lambda s: (not s.get("sharesReference"), _score(s))) if xs else None  # noqa: E731
    close = pick([s for s in statements if s["basis"] == "close"])
    # The 30-day VWAP only where the filing says 30 days: a one-month or
    # three-month average is another reference and stays in premiumStatements.
    vwap30 = pick([s for s in statements if s["basis"] == "vwap" and s["window"] == "30-day"])
    high = pick([s for s in statements if s["basis"] == "high"])
    if close:
        out["premium1Day"] = close["premium"]
        out["unaffectedDate"] = close.get("date")
        out["premiumBasis"].append(close["excerpt"])
        price, where = close.get("price"), "stated with the premium"
        # A price stated elsewhere for the same date is checked against the
        # offer, so it is read for an all-cash deal only: in a stock deal the
        # nearest price to the date is as often the acquirer's (Hess: $166.83
        # is Chevron's close on 20 October 2023).
        if price is None and close.get("date") and texts and ties and cash_only:
            for t in texts:
                price, where = _stated_price_on(t, close["date"], [v for v, _ in ties])
                if price:
                    break
        unit = None
        if price and ties:
            fits = [(v, u) for v, u in ties if abs((v / price - 1) - close["premium"]) <= PREMIUM_FIT]
            if not fits:
                v, u = ties[0]
                out["unaffectedPriceBasis"] = f"the stated price ${price:,.2f} does not reproduce the stated premium with the offer of ${v:,.2f} {'an' if u == 'ADS' else 'a'} {u}, so it is not used"
                price = None
            else:
                unit = min(fits, key=lambda vu: abs((vu[0] / price - 1) - close["premium"]))[1]
        if price:
            out["unaffectedPriceStated"] = price
            out["unaffectedPricePer"] = unit
            out["unaffectedPriceBasis"] = where if where == "stated with the premium" else f"the closing price the filing states for {close['date']}: {where}"
    # The premium to the last close before the agreement was announced, as its
    # own basis beside the unaffected one, wherever the filing states it: where
    # the filing's unaffected day is months earlier (a leak, an approach, a
    # first agreement since revised) this is the figure comparable with a deal
    # that had none.
    pre = pick([s for s in statements if s["basis"] == "close" and s.get("gap") is not None and -1 <= s["gap"] <= 5])
    if pre:
        out["premiumPreAnnouncement"] = pre["premium"]
        out["premiumPreAnnouncementDate"] = pre.get("date")
    if vwap30:
        out["premium30DayVwap"] = vwap30["premium"]
        out["premiumBasis"].append(vwap30["excerpt"])
    if high:
        out["premium52WeekHigh"] = high["premium"]
        out["premiumBasis"].append(high["excerpt"])
    return out


def parse_premiums(text: str, offer: float | None = None, announced: str | None = None) -> dict[str, tuple[float, str]]:
    """The deal's premiums from one document as {1day, vwap30, high52: (fraction, excerpt)}: premium_statements, chosen."""
    kept, _ = premium_statements(text, offer, announced)
    c = choose_premiums(kept, offer, cash_only=False)
    out = {}
    for k, f in (("1day", "premium1Day"), ("vwap30", "premium30DayVwap"), ("high52", "premium52WeekHigh")):
        if c[f] is not None:
            src = next(s for s in kept if s["premium"] == c[f] and (k != "1day" or s["basis"] == "close"))
            out[k] = (c[f], src["excerpt"])
    return out


# ── the share count the document states ──────────────────────────────────────

_SHARES = re.compile(r"(\d{1,3}(?:,\d{3}){1,3})\s+(?:shares\s+of\s+|)(?:the\s+)?(?:Company\s+|Company’s\s+|Company's\s+)?(?:Class\s+A\s+)?(?:[Cc]ommon\s+[Ss]tock|[Cc]ommon\s+[Ss]hares|[Oo]rdinary\s+[Ss]hares|[Cc]ommon\s+[Uu]nits|[Ss]hares)(?P<gap>[^.;]{0,80}?)(?:issued\s+and\s+)?outstanding", re.I)

# What a count beside "outstanding" can be other than the shares outstanding.
# The take-private cover's fee table reads "1,480,457 shares issuable under all
# outstanding and unexercised options" (Tarena), and from 2015 to 2021 that was
# the only count on the cover of Tarena, Gridsum, SKY-MOBI, Dangdang, China Ming
# Yang, Sungy and Perfect World, so it became their share count: Tarena's
# equity value read $5.9m against a fee table of $129m. "Outstanding" there
# belongs to the options; the shares are the ones they would issue. So a count
# is the shares outstanding only where the words between it and "outstanding"
# (a parenthetical that opens and closes inside them aside: "(including
# Shares represented by ADSs)") tie it to nothing else:
#
#   an award or a security   issuable, underlying, subject to, reserved,
#                            pursuant to, available under, upon exercise,
#                            conversion, vesting or settlement, granted, held
#                            in treasury, in exchange for, will remain
#   a holding                a percentage of the outstanding under 100%, or a
#                            majority of it ("33,691,292 shares ...
#                            representing approximately 47% of the
#                            outstanding": Delek's stake in Alon)
#   another instrument       options, warrants, RSUs, restricted stock or share
#                            units or awards, or preferred stock, named before
#                            any second count ("Shares, In-the-Money Company
#                            Stock Options and Company RSUs outstanding";
#                            "325,000 shares of Series B Preferred Stock
#                            outstanding", which was Palm's count; but
#                            "46,756,282 Common Shares, 555,336 Options and
#                            1,452,913 RSUs outstanding" is still a count of
#                            the shares)
#   half a parenthetical     "(145,300 of which were subject to outstanding",
#                            "held in treasury), and (ii) 475,515 Shares": the
#                            "outstanding" is inside a clause the count is not
#
# and only where the words just before it do not make it the shares a security
# converts into, an option or award buys, or a holder owns (_LED_END).
#
# A count that fails is passed over, and another the document states, or
# none, is read in its place: never a count made up. The count is always of
# shares (common, ordinary or Class A) or of a partnership's common units,
# never of ADSs, so it is valued at a price per share.
_LINKED = re.compile(r"\b(?:issuable|underlying|subject\s+to|reserved|pursuant\s+to|available\s+(?:for|under)|with\s+respect\s+to|in\s+exchange\s+for|exercis\w*|conver\w*|vest\w*|settle\w*|granted|treasury|remain\w*)\b", re.I)
_PERCENT = re.compile(r"(\d+(?:\.\d+)?)?\s*(?:%|percent\b|per\s+cent\b)|\bmajority\b", re.I)
_AWARD_INSTRUMENT = re.compile(r"\b(?:options?|warrants?|RSUs?|PSUs?|restricted\s+(?:stock|share)\s+(?:units?|awards?)|preferred)\b", re.I)
_SECOND_COUNT = re.compile(r"\d{1,3}(?:,\d{3})+")
#: the words just before a count that make it something else: a dollar sign
#: ("Net assets at end of year $ 729,856,881 Shares outstanding at end of
#: year 54,474,211": PhenixFIN's net assets, read as its shares), shares a
#: holder offers to buy ("the Company offered to purchase 284,984 shares of
#: its issued and outstanding common shares": a tender), the shares a
#: security converts into or an option buys ("325,000 shares of Series B
#: Preferred Stock outstanding, convertible into 38,235,294 shares of Palm
#: common stock, and 51,000 shares of Series C Preferred Stock outstanding";
#: "the limited option to acquire up to 5,500,000 shares of Common Stock that
#: is outstanding"), or a holder's stake ("collectively held 449,196 shares of
#: the then-outstanding CGC common stock"); "held by 67 holders of record"
#: after a count is not one
_LED = re.compile(r"(?:offer(?:ed|s|ing)?|agree(?:d|s)?|propose(?:d|s)?|elect(?:ed|s)?)\s+to\s+(?:purchase|acquire|buy|repurchase|redeem)|(?:convertible|exercisable|exchangeable|settled|settleable)\s+(?:in|into|for)|(?:options?|warrants?|rights?|units?|awards?|RSUs?|PSUs?)\s+(?:to\s+(?:purchase|acquire|receive)|for|covering|over|relating\s+to|in\s+respect\s+of|with\s+respect\s+to)|\b(?:beneficially\s+)?(?:own|owns|owned|hold|holds|held)|\bpurchase\s+of", re.I)
_LED_END = re.compile(r"(?:" + _LED.pattern + r")\s+(?:(?:up\s+to|approximately|an\s+aggregate\s+of|a\s+total\s+of|of\s+record)\s+)?$|\$\s*$", re.I)


def outstanding_count(gap: str) -> bool:
    """Whether the words between a count of shares and "outstanding" make it the shares outstanding, not an award's, a holding's or a sub-clause's."""
    g = gap
    while True:
        bare = re.sub(r"\([^()]*\)", " ", g)
        if bare == g:
            break
        g = bare
    if "(" in g or ")" in g:
        return False
    if _LINKED.search(g):
        return False
    for m in _PERCENT.finditer(g):
        if m.group(0).lower() == "majority" or m.group(1) is None or float(m.group(1)) < 100:
            return False
    own = _SECOND_COUNT.split(g, 1)[0]
    return not _AWARD_INSTRUMENT.search(own)


def parse_shares(text: str, *, company: str | None = None, evidence: list[str] | None = None, offer: float | None = None) -> tuple[float | None, str | None]:
    """Shares outstanding as the transaction statement states them (Item 1(b)), in millions, with the phrase: read_shares on the one document (the others, where given, as evidence of the consideration each class receives)."""
    r = read_shares(text, company=company, evidence=evidence, offer=offer)
    return (r["count"], r["phrase"]) if r and r.get("count") else (None, None)


# ── share classes ────────────────────────────────────────────────────────────
#
# A company with more than one class of common stock or ordinary shares states
# the count of each: "80,653,284 Class A ordinary shares and 109,386,066 Class B
# ordinary shares issued and outstanding" (Sungy), "(i) 29,671,195 Class A
# Shares are issued and outstanding, ... (ii) 219,266,335 Class B Shares are
# issued and outstanding" (Perfect World). Read one count at a time, the
# reader took the class stated most often: Sungy's equity value was its Class A
# alone, $65.9m of $155.2m, Perfect World's $119.9m against a fee table of
# $868.7m, and BBX's its 195,045 Class B shares, $2.0m.
#
# Economic ownership decides, not the number of classes in the capitalisation
# table. Where one sentence states the count of each of two or more classes of
# the target outstanding (a class statement), the count for equity value is
# the sum of the classes that receive the merger consideration, and only where
# the filing shows that they do: a clause from its "each" to its "right to
# receive" naming the classes together ("Each Class A ordinary share ... and
# each Class B ordinary share ... shall be cancelled ... in exchange for the
# right of the holder of such Share to receive US$0.81667"), directly or
# through a term defined as them together ("the Class A Shares and the Class B
# Shares, together the “Shares”"), or each in its own clause at the same price.
# A class the filing shows has no economic interest ("Our Class X Common Stock
# and Class Y Common Stock do not have any of the economic rights":
# Endeavor), is cancelled for no consideration, or is paid a nominal sum for
# its votes (under 1% of the offer: Pluralsight's $0.0001) is left out and
# named with the reason; a class exchanged into the paid class before the
# merger counts with it ("all of which will be cancelled as a result of the
# Exchanges": Neff; Emdeon). Where the filing prices each class reliably,
# each is counted at its own price (Unified Grocers' Class E at $100.00 beside
# $200.27), and equity value is the sum. A class whose terms the filing does
# not show leaves no count at all, and the reading says why: a count of one
# class of several is not the company's, and a count is never made up.
#
# A count is the target's own. "137,008,911 shares of EXPE and 12,799,999
# shares of Expedia class B common stock" in a Liberty Interactive proxy, or
# "75,848,502 shares of BFC’s Class A Common Stock" in BBX Capital's, is
# another company's, so a count whose words name an issuer (its name, or a
# ticker or short name) is read only where that issuer is the target: a word
# of one of its names (its name now, or the one its own filing's cover gives:
# PhenixFIN filed as Medley Capital Corporation), a ticker whose letters run
# through that name, or a short name the documents define directly after it
# ("Medley Capital Corporation (“MCC”)"). A count that names the target beats
# one that names no one, however often the unnamed is stated. Preferred stock, ADSs and partnership units are not classes of
# this kind: preferred is a claim beside the common, an ADS is a different
# unit (a count of them never mixes into a count of shares), and a
# partnership's units are read as before.

_NUMBER = re.compile(r"(?<![\d,.$])(\d{1,3}(?:,\d{3}){1,3})(?![\d,]|\.\d)")
#: a class of common stock or ordinary shares: Class A, Series B, Class B-2,
#: voting and nonvoting (Jacksonville Bancorp)
_CLASS = re.compile(r"\b(?i:(class|series))\s+([A-Z](?:-\d)?)\b|\b(?i:(non-?\s?voting|voting))\s+(?i:common|ordinary)\b")
#: where a mention's own words end: the first of these after its count
_DESC_END = re.compile(r"\boutstanding\b|[,;(]|\band\b|\bof\s+which\b|\bwhich\b|\bthat\b|\bheld\b|\bowned\b|\brepresent|\bissuable\b|\bunderlying\b|\bsubject\b|\breserved\b|\bas\s+of\b|\bon\s+the\b", re.I)
_CONNECTOR = re.compile(r"\s*[,;]?\s*(?:and|or)?\s*(?:\(\s*(?:[ivx]{1,4}|[a-zA-Z])\s*\)\s*)?", re.I)
_STOCK = re.compile(r"\b(?:stock|shares?|common)\b", re.I)
_PREFERRED = re.compile(r"\b(?:preferred|preference)\b", re.I)
_ADS = re.compile(r"\bADSs?\b|\bAmerican\s+Depositary\b|\bdepositary\s+shares\b", re.I)
_UNIT_NOUN = re.compile(r"\bunits?\b", re.I)
#: what a count names where it is the total of the classes: the common stock,
#: the ordinary shares, or the Shares as a defined term
_TOTAL_NOUN = re.compile(r"\b(?i:common\s+stock|common\s+shares|ordinary\s+shares|capital\s+stock)\b|\bShares\b")
#: an authorized total ("750,000,000 shares of Company Class A Common Stock,
#: of which 87,423,775 shares are issued and outstanding": Inovalon) is not a
#: count of the shares outstanding; the count after "of which" is
_OF_WHICH = re.compile(r"\bof\s+which\b|\bauthori[sz]ed\b", re.I)
#: an authorized total by the words before it ("Authorized 1,600,000 shares;
#: issued: 220,383 and 196,802 shares", a balance sheet in thousands)
#: a part of the outstanding: "100,886 Shares of the Fund’s issued and
#: outstanding Shares" (a tender), "284,984 shares of its issued and outstanding"
_PARTITIVE = re.compile(r"(?<!all\s)\bof\s+(?:the\s+|its\s+|our\s+|their\s+)(?:[A-Z][\w’']*\s+){0,3}(?:issued\s+and\s+)?$")
#: words after "outstanding" that make the count a part of the outstanding:
#: "7,341,052 shares of common stock outstanding and held by stockholders
#: other than Mr. Fertitta" (Landry's), "9,159,929 shares of common stock of
#: GTC outstanding that were not beneficially owned by LFB"
_NOT_ALL = re.compile(r"\s*,?\s*(?:and\s+)?(?:that\s+(?:were|are)\s+not|which\s+(?:were|are)\s+not|not\s+(?:held|owned|beneficially)|(?:held|owned)\s+by\s+(?:stockholders|shareholders|holders|persons)\s+other\s+than|other\s+than)\b", re.I)
_AUTHORIZED_LEAD = re.compile(r"\bauthori[sz]ed\b[\s\w,:;]{0,30}$", re.I)
_GENERIC = frozenset("""
shares share of the our its their company company's issued common ordinary stock capital class series voting nonvoting non-voting
vote-only were are is was be been being have has had then currently entitled to vote in each case respectively all such par value
per a an total aggregate approximately restricted unrestricted outstanding there and or as at on date record new existing
any other this that these those such holders holder registered fully paid non-assessable nonassessable validly duly
units unit limited partnership partner partners general depositary american
""".split())
#: words a company's name carries that say nothing of which company it is
_NAME_FILLER = frozenset("inc incorporated corp corporation co company ltd limited plc llc lp holdings holding group the of and international intl sa nv ag se trust old".split())
_RECEIVES = re.compile(r"\bright\s+(?:of\s+[^.;]{0,60}?\s+)?to\s+receive\b", re.I)
_NEGATED = re.compile(r"\bnot\s+be\s+(?:converted|exchanged|entitled)|\bno\s+(?:payment|consideration|merger\s+consideration)\b|\bwithout\s+(?:any\s+)?(?:payment|consideration)\b|\bnot\s+(?:be\s+)?entitled\s+to\s+receive", re.I)
#: a subset of a class, not the class: shares a holder rolls over, holds, or dissents with
_SUBSET = re.compile(r"\bheld\s+(?:by|in)\b|\bowned\s+by\b|\bRollover\b|\bExcluded\b|\bDissent|\btreasury\b|\brepresented\s+by\b", re.I)
#: the subject of a conversion: each share (of a class), each Class A share,
#: each issued and outstanding share; never "each holder", whose "right to
#: receive" is what a surrendered certificate still carries
_EACH = re.compile(r"\b(?i:each)\s+(?!(?i:holder|record|certificate|book|option|award|warrant|unit|RSU|PSU)\w*\b)(?:[\w’'&.,-]+\s+){0,4}?(?:(?i:shares?|stock)\b|(?i:class|series)\s+[A-Z]\b)|\b(?i:all)\s+(?:of\s+the\s+)?(?:issued\s+and\s+)?(?:outstanding\s+)?(?i:shares)\b")
#: the price a receiving clause names: a dollar amount, or a defined
#: consideration, with the class it is for where it names one ("the Class B
#: Per Share Price" is not the Class A's "Per Share Price")
_MONEY_AFTER = re.compile(r"(?:US)?\$\s?(\d[\d,]*(?:\.\d+)?)|\b((?:(?:class|series)\s+[A-Z](?:-\d)?\s+)?(?:per\s+share\s+)?(?:merger\s+consideration|offer\s+price|per\s+share\s+(?:consideration|price|amount)|cash\s+consideration))\b", re.I)
_TOGETHER = re.compile(r"\b(?:collectively|together)\b[^“”\"()]{0,60}?[“\"]\s*(?:the\s+)?([^”\"]{2,60}?)\s*[”\"]", re.I)
_NON_ECONOMIC = re.compile(r"\b(?:do|does|shall|will)\s+not\s+(?:have|carry|entitle\s+\w+\s+to)\s+any(?:\s+of\s+the)?\s+economic\s+(?:rights?|interest)|\b(?:has|have|carry|carries|with)\s+no\s+economic\s+(?:rights?|interest)|\bnon-?economic\b|\b(?:vote|voting)[- ]only\b|\bvoting\s+rights\s+only\b", re.I)
_CANCELLED_FREE = re.compile(r"\b(?:will|shall)\s+(?:automatically\s+)?be\s+(?:automatically\s+)?cancel+ed(?:\s+and\s+(?:retired|extinguished|cease\s+to\s+exist))?\s+(?:without\s+any\s+conversion|for\s+no\s+consideration|without\s+(?:any\s+)?(?:payment|consideration))", re.I)
_ALL_CANCELLED = re.compile(r",?\s*all\s+of\s+which\s+(?:will|shall)\s+be\s+(?:cancel+ed|retired|exchanged)", re.I)


def _flat(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


@lru_cache(maxsize=16)
def _sentences(text: str) -> list[tuple[int, int]]:
    """The text's sentences as (start, end): a full stop before a capital ends one, unless it closes an abbreviation (Inc., U.S., No.) or an initial."""
    out, start = [], 0
    for m in re.finditer(r"\.(?=\s+[A-Z“\"(•\[])", text):
        before = text[max(0, m.start() - 8):m.start()]
        if re.search(r"(?:\b(?:Inc|Corp|Co|Ltd|No|Nos|Mr|Mrs|Ms|Dr|Jr|Sr|St|vs|Messrs|approx|Sec|Ex|Art|Bros|Cos)|\b[A-Z]|\.[A-Za-z])$", before):
            continue
        out.append((start, m.end()))
        start = m.end()
    out.append((start, len(text)))
    return out


def _labels(s: str) -> list[str]:
    """The classes a passage names, in order: 'A', 'B-2', 'Series A' (never the same class as a Class A), 'voting', 'nonvoting'."""
    out = []
    for m in _CLASS.finditer(s):
        if m.group(2):
            lab = m.group(2) if m.group(1).lower() == "class" else f"Series {m.group(2)}"
        else:
            lab = re.sub(r"[-\s]", "", m.group(3).lower())
        if lab not in out:
            out.append(lab)
    return out


def _names(company: str | tuple[str, ...] | list[str] | None) -> tuple[str, ...]:
    """The target's names as one tuple: its name, and any it filed under."""
    if not company:
        return ()
    return (company,) if isinstance(company, str) else tuple(n for n in company if n)


def _name_words(company: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9&]+", company.lower().replace("’", "'").replace("'s ", " ")) if w]


def _issuer(desc: str) -> str:
    """The words of a mention that name a company: what is left once the share vocabulary, the class and the verbs are taken out."""
    words = []
    for w in re.findall(r"[A-Za-z][\w&.’'-]*", re.sub(r"\([^()]*\)", " ", desc)):
        w = re.sub(r"(?:’|')s$", "", w).strip(".")
        if w.lower() in _GENERIC or re.fullmatch(r"[A-Z](?:-\d)?", w) or not w:
            continue
        words.append(w)
    return " ".join(words)


#: a name the documents define as the Company: "General Communication, Inc., an
#: Alaska corporation (the “Company”)"
_COMPANY_DEFINED = re.compile(r"((?:[A-Z][\w&.,’'-]*\s+){1,6}?)(?:[^()“”\";]{0,60}?)\(\s*(?:[^()]{0,60}?)[“\"]\s*(?:the\s+)?Company\s*[”\"]")


@lru_cache(maxsize=256)
def _company_is_target(names: tuple[str, ...], texts: tuple[str, ...]) -> bool:
    """Whether "the Company" of the documents is the target: true where they define it as one of the target's names, or do not define it."""
    own = {w for n in names for w in _name_words(n) if w not in _NAME_FILLER}
    names = [m.group(1) for t in texts for m in _COMPANY_DEFINED.finditer(t)]
    return not names or any(own & {w for w in _name_words(n) if w not in _NAME_FILLER} for n in names)


#: the name a filing is made under, from its cover: "MEDLEY CAPITAL
#: CORPORATION (Name of Registrant as Specified In Its Charter)"
#: (never an S-4's "Exact name of registrant", which is the acquirer's)
_COVER_NAME = re.compile(r"((?:[A-Z][\w&.,’'-]*\s+){1,8})\(\s*(?i:name\s+of\s+(?:the\s+)?(?:registrant|subject\s+company|issuer))\b")


def registrant_names(text: str) -> list[str]:
    """The names a document's cover says it is filed for (the registrant, or a 13E-3's subject company), at most two, in the order they appear."""
    out: list[str] = []
    for m in _COVER_NAME.finditer(text[:20000]):
        # the words after the cover's own headings ("... RULE 13E-3
        # THEREUNDER GTC BIOTHERAPEUTICS, INC. (Name of the Issuer)")
        n = re.split(r"(?i)\b(?:thereunder|1934|act|statement|amendment(?:\s+no\.?)?(?:\s+\d+)?|13e-3|e-3|14a|14c|14d-9|schedule|rule|to)\b\.?", _flat(m.group(1)))[-1].strip(" ,.")
        if n and any(w not in _NAME_FILLER for w in _name_words(n)) and n not in out:
            out.append(n)
    return out[:2]


def _in_order(letters: str, word: str) -> bool:
    it = iter(word)
    return all(ch in it for ch in letters)


@lru_cache(maxsize=1024)
def _is_target(issuer: str, names: tuple[str, ...], texts: tuple[str, ...], *, generic_company: bool = False) -> bool:
    """
    Whether the issuer a mention names is the target: no issuer named, or one
    of the target's names (its name now, or the one its own filing was made
    under: Medley Capital Corporation for PhenixFIN) by a word, its initials
    or a short name the documents give it. A mention of "the Company" is the
    target's unless the documents define the Company as another.
    """
    if not names:
        return True
    if not issuer:
        return not generic_company or _company_is_target(names, texts)
    return any(_names_target(issuer, n, texts) for n in names)


def _names_target(issuer: str, company: str, texts: tuple[str, ...]) -> bool:
    first = issuer.split()[0]
    words = _name_words(company)
    own = [w for w in words if w not in _NAME_FILLER]
    # Every word the issuer is named by is a word of the target's name
    # ("Liberty TripAdvisor" for Liberty TripAdvisor Holdings; "Liberty
    # Ventures" is not Liberty Interactive).
    named = [re.sub(r"[^a-z0-9&]", "", p) for w in issuer.split() for p in re.split(r"[-–]", w.lower())]
    named = [w for w in named if w and w not in _NAME_FILLER]
    if named and all(w in words for w in named) and any(w in own for w in named):
        return True
    # A ticker or short name in capitals: its letters in order through the
    # target's name, from its first letter (UB for Urstadt Biddle, G&W for
    # Genesee & Wyoming, DTG for Dollar Thrifty Automotive Group, PAS for
    # PepsiAmericas); BFC is not BBX Capital, nor EXPE Liberty Interactive.
    letters = re.sub(r"[^a-z]", "", first.lower())
    whole = "".join(w for w in words if w not in ("inc", "incorporated", "corp", "corporation", "co", "ltd", "limited", "plc", "llc", "lp", "the", "and", "of", "&"))
    if 2 <= len(letters) <= 6 and first.replace("&", "").isupper() and whole[:1] == letters[:1] and _in_order(letters, whole):
        return True
    # the short name as the documents quote it: all of it ("FSIC III"), or its first word
    qs = [re.escape(issuer).replace(r"\ ", r"\s+")] + ([re.escape(first)] if " " in issuer else [])
    q = "(?:" + "|".join(qs) + ")"
    # A short name defined directly after the first word of the target's
    # name, with only its words, suffixes and punctuation between ("Emdeon
    # Inc. (“Emdeon”"), never another name ("Abraxis, Celgene Corporation
    # (“Celgene”)").
    name = r"(?:[\s,.’']|\b(?:" + "|".join(re.escape(w) for w in sorted(set(words) | _NAME_FILLER, key=len, reverse=True)) + r")\b){0,60}"
    after_name = [re.compile(r"\b" + re.escape(w) + r"\b" + name + r"\(\s*(?:the\s+)?[“\"]\s*(?:the\s+)?" + q + r"\s*[,”\"]", re.I) for w in own[:1]]
    for t in texts:
        if any(p.search(t) for p in after_name):
            return True
    return False


def _mentions(sent: str) -> list[dict]:
    """
    Every count in a sentence with what it is a count of: its classes, whether
    preferred, ADSs or units, the issuer its words name, and whether the
    sentence states it as outstanding (in its own clause, or as one of a list
    that ends in "outstanding": "X Class A ordinary shares and Y Class B
    ordinary shares issued and outstanding").
    """
    # A count inside a parenthetical belongs to the mention before it
    # ("32,882,292 shares of Company Class A Common Stock ... (including
    # 1,707,268 shares of Company Restricted Stock)"), not to the list.
    depth, depths = 0, {}
    for i, ch in enumerate(sent):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        depths[i] = depth
    nums = [m for m in _NUMBER.finditer(sent) if depths.get(m.start(), 0) == 0]
    out: list[dict] = []
    for i, m in enumerate(nums):
        nxt = nums[i + 1].start() if i + 1 < len(nums) else len(sent)
        seg = sent[m.end():nxt]
        e = _DESC_END.search(seg)
        desc = seg[:e.start()] if e else seg
        lead = sent[max(0, m.start() - 60):m.start()]
        # The words since the last count or list marker: an award's count
        # ("(v) Company RSUs relating to 1,032,158 shares of Company Common
        # Stock were outstanding") or a total ("for a total of 48,016,533
        # shares of common stock outstanding") is not a class's.
        since = sent[(nums[i - 1].end() if i else 0):m.start()]
        since = re.split(r";|\(\s*(?:[ivx]{1,4}|[a-zA-Z]|\d{1,2})\s*\)", since)[-1][-80:]
        mention = {"n": float(m.group(1).replace(",", "")), "start": m.start(), "end": m.end(), "desc": desc, "seg": seg,
                   "labels": _labels(desc), "stock": bool(_STOCK.search(desc)),
                   "kind": "preferred" if _PREFERRED.search(desc) else "ads" if _ADS.search(desc) else "units" if _UNIT_NOUN.search(desc) else "shares",
                   "issuer": _issuer(desc),
                   "award": bool(_AWARD_INSTRUMENT.search(since)) and not _PREFERRED.search(since),
                   "total": bool(re.search(r"\b(?:total|aggregate|in\s+all|altogether)\b(?:\s+of)?\s*$", since, re.I)
                                 or re.search(r"^[^,;()]{0,80}?\b(?:comprised|consisting|composed|made\s+up)\s+of\b", seg, re.I))}
        o = re.search(r"\boutstanding\b", seg, re.I)
        if o:
            gap = seg[:o.start()]
            mention["out"] = outstanding_count(gap) and not _OF_WHICH.search(gap.split("(")[0]) and not _LED_END.search(lead) and not _PREFERRED.search(_SECOND_COUNT.split(gap, 1)[0])
            mention["upto"] = m.end() + o.end()
        else:
            rest = re.sub(r"\([^()]*\)", " ", seg[len(desc):])
            # One of a list ending in "outstanding" only where its own words
            # are a class's name and nothing more ("41,237 Class A shares
            # issued in the USWS Acquisition" is not)
            plain = not re.search(r"\b(?:issued|in|for|to|by|from|under|upon|pursuant|at|with)\b", desc, re.I)
            mention["out"] = None if plain and _CONNECTOR.fullmatch(rest) and not _LED_END.search(lead) else False
            mention["upto"] = nxt
        out.append(mention)
    # A list's members are outstanding where the list ends in "outstanding".
    for i in range(len(out) - 1, -1, -1):
        if out[i]["out"] is None:
            out[i]["out"] = bool(i + 1 < len(out) and out[i + 1]["out"])
    return out


@lru_cache(maxsize=16)
def _statements(text: str, names: tuple[str, ...], texts: tuple[str, ...]) -> list[dict]:
    """
    The class statements in a document: the counts of two or more classes of
    the target outstanding, stated in one sentence, each a dict of its
    classes and counts with its phrase. An award's count or the total of the
    classes beside them is passed over without ending the list.
    """
    statements = []
    for a, b in _sentences(text):
        sent = text[a:b]
        if not re.search(r"\b(?i:class|series|voting)\b", sent) or not _NUMBER.search(sent):
            continue
        run: list[dict] = []

        def close():
            if len(run) >= 2:
                statements.append({"classes": [(m["labels"][0], m["n"]) for m in run],
                                   "phrase": _flat(sent[run[0]["start"]:run[-1]["upto"]])[:400]})
            run.clear()

        for m in _mentions(sent):
            if m["award"] or m["total"] or re.search(r"\brestricted\b", m["desc"], re.I):
                # "4,650,661 restricted Class A shares": a part of the class
                continue
            ok = (m["out"] and m["kind"] == "shares" and m["stock"] and m["n"] >= 1000 and len(m["labels"]) <= 1
                  and _is_target(m["issuer"], names, texts, generic_company=bool(re.search(r"\bCompany", m["desc"]))))
            if not ok:
                if m["kind"] != "preferred" and m["n"] >= 1000:
                    close()
                continue
            if not m["labels"] and not re.search(r"\b(?:common|ordinary)\b", m["desc"], re.I):
                # "157,950,354 shares are outstanding": no class named, so
                # the total, not a class beside the others
                continue
            lab = m["labels"][0] if m["labels"] else "common"
            if any((x["labels"][0] if x["labels"] else "common") == lab for x in run):
                close()
            m["labels"] = [lab]
            run.append(m)
        close()
    return statements


@lru_cache(maxsize=8)
def _terms(texts: tuple[str, ...]) -> tuple[list[tuple[frozenset, float | str | None, str]], dict[str, str]]:
    """
    What the documents say each class receives: the groups of classes a
    clause names as converted into the right to receive something, from its
    "each" to its verb ("Each Class A ordinary share ... and each Class B
    ordinary share ... shall be cancelled ... in exchange for the right of the
    holder of such Share to receive US$0.81667"), each with the price it
    names (a dollar amount, or a defined consideration such as the "Per Share
    Merger Consideration"), and the classes it shows are not acquired.
    """
    groups: list[tuple[frozenset, float | str | None, str]] = []
    excluded: dict[str, str] = {}
    exchanged: set[str] = set()
    for t in texts:
        defined: dict[str, frozenset] = {}
        for a, b in _sentences(t):
            sent = t[a:b]
            if not re.search(r"\b(?i:class|series|voting|shares?|stock)\b", sent):
                continue
            for m in _TOGETHER.finditer(sent):
                labs = _labels(sent[max(0, m.start() - 400):m.start()])
                if len(labs) >= 2:
                    defined[m.group(1).strip().lower()] = frozenset(labs)
            for m in re.finditer(r"\b(?i:class|series)\s+[A-Z](?:-\d)?\b(?:(?!\d{1,3},\d{3})[^.;]){0,120}?" + _ALL_CANCELLED.pattern, sent):
                # not where the shares cancelled are a holder's ("BFC owns ...
                # 100% of the outstanding shares of BBX Capital’s Class B
                # Common Stock, all of which will be canceled")
                if not _SUBSET.search(sent[max(0, m.start() - 200):m.end()]) and not re.search(r"\b(?:own|owns|owned|hold|holds)\b", sent[max(0, m.start() - 200):m.end()], re.I):
                    after = sent[m.end():m.end() + 80]
                    why = "exchanged" if re.match(r"\s*(?:as\s+a\s+result\s+of|upon|in\s+connection\s+with)\s+the\s+(?:Exchanges?|exchange)", after, re.I) else "cancelled"
                    excluded.setdefault(_labels(m.group(0))[-1], f"{why}: " + _flat(m.group(0) + after)[:240])
            # A class with votes and no economic interest is not bought for
            # the price ("Our Class X Common Stock and Class Y Common Stock do
            # not have any of the economic rights ... associated with our Class
            # A Common Stock": Endeavor; "vote-only Class B Common Stock":
            # Fathom), and nor is a class cancelled without conversion ("shares
            # of Company Class X Common Stock and Company Class Y Common Stock
            # ... will be automatically cancelled without any conversion thereof").
            for m in _NON_ECONOMIC.finditer(sent):
                before = re.split(r"[;•,:“”\"()]", sent[max(0, m.start() - 300):m.start()])[-1]
                for lab in _stock_labels(before) or _stock_labels(sent[m.end():m.end() + 60])[:1]:
                    excluded.setdefault(lab, "voting rights only, no economic interest: " + _flat(sent[max(0, m.start() - 160):m.end()])[-240:])
            for m in _CANCELLED_FREE.finditer(sent):
                head = _cancelled_class(sent[max(0, m.start() - 400):m.start()])
                for lab in _stock_labels(head):
                    excluded.setdefault(lab, "cancelled for no consideration: " + _flat(head + " " + m.group(0))[-240:])
            prev = 0
            for v in _RECEIVES.finditer(sent):
                subject = sent[prev:v.start()]
                prev = v.end()
                e = _EACH.search(subject)
                if not e or len(subject) - e.start() > 900:
                    continue
                span = subject[e.start():]
                # The classes it names, not those its parentheticals except
                # ("(other than ... Class X Common Stock ...)": Endeavor)
                bare = span
                while True:
                    b2 = re.sub(r"\([^()]*\)", " ", bare)
                    if b2 == bare:
                        break
                    bare = b2
                labs = set(_labels(bare))
                # A class exchanged into the one that receives the price
                # before the merger ("each share of Emdeon Class A common
                # stock (including each share ... resulting from the exchange
                # of ... EBS Units ... and corresponding shares of Emdeon Class
                # B common stock ...)") is acquired on its terms.
                if labs:
                    for x in re.finditer(r"\bresulting\s+from\s+(?:the\s+)?(?:exchange|conversion|redemption)\s+of\b[^.;]{0,300}", span, re.I):
                        labs |= set(_labels(x.group(0)))
                        exchanged |= set(_labels(x.group(0)))
                # "each share of Common Stock and Class B Stock": the class
                # named only as common stock, where another is named by letter
                if labs and any(not re.search(r"(?:\b(?i:class|series)\s+[A-Z](?:-\d)?|voting)\s*$", bare[max(0, c.start() - 14):c.start()])
                                for c in re.finditer(r"\b(?i:common\s+(?:stock|shares?)|ordinary\s+shares?)\b", bare)):
                    labs.add("common")
                low = _flat(bare).lower()
                for term, members in defined.items():
                    if re.search(r"\b" + re.escape(term.rstrip("s")) + r"s?\b", low):
                        labs |= members
                if not labs:
                    continue
                quote = _quote(span, sent[v.start():v.end() + 80])
                if _NEGATED.search(span) or _NEGATED.search(sent[v.start():v.end() + 80]):
                    if not _SUBSET.search(span):
                        for lab in labs:
                            excluded.setdefault(lab, "not converted into the consideration: " + quote)
                    continue
                after = sent[v.end():v.end() + 160]
                # the first price named after the verb, a par value aside
                k = next((x for x in _MONEY_AFTER.finditer(after) if not re.search(r"par\s+value\s*(?:of\s*)?$", after[max(0, x.start() - 16):x.start()], re.I)), None)
                key = None if not k else (float(k.group(1).replace(",", "")) if k.group(1) else re.sub(r"\s+", " ", k.group(2).lower()))
                groups.append((frozenset(labs), key, quote))
    # What is left of a class once it has been exchanged into the class the
    # price is paid on is cancelled for nothing, but the class was bought:
    # Emdeon's Class B, exchanged with its EBS Units into Class A
    for lab in exchanged:
        if excluded.get(lab, "").startswith("cancelled for no consideration"):
            del excluded[lab]
    return groups, excluded


def _stock_labels(s: str) -> list[str]:
    """The classes a passage names as stock ("Class B Common Stock", "Class X shares"), not as the name of something else ("the Class A exchange ratio")."""
    return [lab for lab in _labels(s) if lab in ("voting", "nonvoting") or re.search(r"\b" + (re.escape(lab) if " " in lab else r"(?i:class)\s+" + re.escape(lab)) + r"\b\s+(?:(?i:common|ordinary|shares?|stock))\b", s)]


def _cancelled_class(before: str) -> str:
    """
    The class a "will be cancelled without consideration" clause is about: its
    subject from "each", "all" or a list marker's "shares of" to the first
    word that narrows it ("that", "which", "other than"), parentheticals aside;
    nothing where the subject is an award, a holder's shares or a part of the
    class ("all outstanding shares of Emdeon Class B common stock that are not
    converted", "Gato will contribute 15,744,913 shares ... which shares will
    be cancelled").
    """
    bare = before
    while True:
        b2 = re.sub(r"\([^()]*\)", " ", bare)
        if b2 == bare:
            break
        bare = b2
    starts = list(re.finditer(r"\b(?i:each|all)\b|\(\s*(?:[ivx]{1,4}|[A-Za-z])\s*\)\s+(?=(?i:shares)\b)|^\s*(?=(?i:shares)\s+of\b)", bare))
    if not starts:
        return ""
    head = bare[starts[-1].start():]
    if _AWARD_INSTRUMENT.search(head) or _SUBSET.search(head) or re.search(r"\b(?:own|owns|owned|hold|holds|contribut\w*)\b", head, re.I):
        return ""
    cut = re.search(r"\b(?:that|which|who|other\s+than|except|not)\b", head, re.I)
    return head[:cut.start()] if cut else head


def _quote(span: str, verb: str) -> str:
    """The clause as kept on the row: from its "each" (or, where that is far, from a word some 300 characters back) to just past the verb."""
    head = _flat(span)
    if len(head) > 300:
        head = "… " + head[-300:].split(" ", 1)[-1]
    tail = _flat(verb)
    tail = tail if len(tail) < 80 else tail.rsplit(" ", 1)[0]
    return f"{head} {tail}"


def _resolve(classes: list[tuple[str, float]], groups, excluded, offer: float | None = None) -> dict:
    """
    Which of a statement's classes receive the consideration on the same
    terms, which are not acquired, and the count. A clause that prices a class
    at a dollar amount other than the offer (Pluralsight's Class B and C
    shares, "$0.0001", beside the Class A's $20.26) is no evidence that it
    shares the offer. Where the filing prices each class reliably (one
    dollar amount a share, in a clause of its own) the classes are counted at
    their own prices (classPrices) and equity value is the sum; a class priced
    at under 1% of the offer is a nominal payment for votes, not a share of the
    company, and is left out and named.
    """
    labs = [c for c, _ in classes]
    mine = set(labs)
    same: set[str] = set()
    terms = None
    differs: dict[str, dict[float, str]] = {}
    by_key: dict = {}
    terms_priced = False
    # A class priced by a consideration of its own ("the Class B Per Share
    # Price") does not share the offer's, whatever else names it with others.
    own_terms = {}
    for g, key, phrase in groups:
        m = re.match(r"(?:class|series)\s+([a-z](?:-\d)?)\s", key) if isinstance(key, str) else None
        if m:
            lab = m.group(1).upper() if key.startswith("class") else f"Series {m.group(1).upper()}"
            if lab in g and lab in mine and len(g & mine) == 1:
                own_terms[lab] = key
    for g, key, phrase in groups:
        hit = g & mine - set(own_terms)
        if not hit:
            continue
        if isinstance(key, float) and offer and abs(key / offer - 1) > 0.005:
            for c in hit:
                differs.setdefault(c, {}).setdefault(round(key, 6), phrase)
            continue
        if isinstance(key, str) and re.match(r"(?:class|series)\s", key):
            # a consideration named for one class is no evidence that the
            # classes beside it share the offer
            continue
        priced_here = isinstance(key, float)
        if len(hit) >= 2 and (len(hit) > len(same) or (hit == same and priced_here and not terms_priced)):
            # the clause that names the price is the one quoted, where there is one
            same, terms, terms_priced = set(hit), phrase, priced_here
        if key is not None:
            k = round(key, 4) if isinstance(key, float) else key
            by_key.setdefault(k, set()).update(hit)
            if len(by_key[k]) >= 2 and len(by_key[k]) > len(same):
                same, terms, terms_priced = set(by_key[k]), phrase, priced_here
    # A class shown not to be bought (cancelled for nothing, or votes without
    # an economic interest) is left out even where a broad term names it with
    # the others ("each share of Company Common Stock").
    firm = {c for c, why in excluded.items() if not why.startswith("not converted")}
    out = [c for c in labs if c in firm or (c in excluded and c not in same)]
    # A class paid a nominal amount (under 1% of the offer: Pluralsight's
    # Class B and C, "$0.0001", beside $20.26) is paid for its votes, not
    # bought as a share of the company: left out and named.
    for c in labs:
        if c not in out and c not in same and c in differs and len(differs[c]) == 1 and offer:
            price, passage = next(iter(differs[c].items()))
            if price < 0.01 * offer:
                out.append(c)
                excluded = {**excluded, c: f"nominal consideration of ${price:,.6g} a share against the offer's ${offer:,.6g}: {passage}"}
    # A class whose remainder is cancelled once it has been exchanged into
    # the class that is paid ("all of which will be cancelled as a result of
    # the Exchanges": Neff) is bought as that class.
    swapped = [c for c in out if excluded[c].startswith("exchanged")]
    out = [c for c in out if c not in swapped]
    same -= set(out)
    same -= set(swapped)
    if not same:
        rest = mine - set(out) - set(swapped)
        for g, key, phrase in groups:
            if g & mine == rest and len(rest) == 1 and not (isinstance(key, float) and offer and abs(key / offer - 1) > 0.005):
                same, terms = set(rest), phrase
                break
    if same and swapped:
        same |= set(swapped)
    unknown = [c for c in labs if c not in same and c not in out]
    named = [{"class": c, "count": round(n / 1e6, 3)} for c, n in classes]
    # A class under 1% of the shares whose terms the filing does not show
    # (OMNI's 5,939 Series C shares beside 22.8m common) cannot move the
    # count by more than that: it is left out and named, not a reason for none.
    whole = sum(n for _, n in classes)
    small = [c for c in unknown if c not in differs and dict(classes)[c] < 0.01 * whole]
    if same and small and len(small) == len(unknown):
        out += small
        excluded = {**excluded, **{c: "terms not shown; under 1% of the shares" for c in small}}
        unknown = []
    priced = {c: next(iter(differs[c].items())) for c in unknown if c in differs and len(differs[c]) == 1}
    if same and unknown and all(c in priced for c in unknown):
        counts = dict(classes)
        # price None: the offer's, whatever the offer reader later makes it
        parts = [{"class": _class_name(c), "count": round(counts[c] / 1e6, 6), "price": None, "terms": terms} for c in labs if c in same]
        parts += [{"class": _class_name(c), "count": round(counts[c] / 1e6, 6), "price": priced[c][0], "terms": priced[c][1]} for c in labs if c in unknown]
        r = {"count": round(sum(counts[c] for c in labs if c in same or c in unknown) / 1e6, 6), "classes": named,
             "summed": [_class_name(c) for c in labs if c in same or c in unknown], "terms": terms, "classPrices": parts}
        if out:
            r["excluded"] = [{"class": _class_name(c), "why": excluded[c]} for c in out]
        return r
    if unknown or not same:
        diff = [c for c in unknown if c in differs]
        if any(c in own_terms for c in unknown):
            why = "; ".join(f"{_class_name(c)} receives {own_terms[c].title().replace('Per Share', 'per share')}" for c in unknown if c in own_terms) + ", its own consideration: the classes are not summed"
        elif diff:
            why = "; ".join(f"{_class_name(c)} receives " + " or ".join(f"${x:,.6g}" for x in differs[c]) + " a share" for c in diff) + f", not the offer's ${offer:,.6g}, and the filing does not price every class: the classes are not summed"
        else:
            why = "the filing states " + ", ".join(_class_name(c) for c in labs) + " outstanding and does not show that " + ("they receive" if len(unknown) != 1 else _class_name(unknown[0]) + " receives") + " the same consideration per share"
        return {"count": None, "classes": named, "why": why}
    total = sum(n for c, n in classes if c in same) / 1e6
    r = {"count": round(total, 6), "classes": named, "summed": [_class_name(c) for c in labs if c in same], "terms": terms}
    if out:
        r["excluded"] = [{"class": _class_name(c), "why": excluded[c]} for c in out]
    return r


def _class_name(lab: str) -> str:
    return {"common": "the common stock", "voting": "the voting common stock", "nonvoting": "the nonvoting common stock"}.get(lab, f"Class {lab}" if len(lab) <= 3 else lab)


def read_shares(text: str, *, company: str | tuple[str, ...] | None = None, evidence: list[str] | None = None, classes: set[str] | None = None, offer: float | None = None) -> dict | None:
    """
    The share count a document states for the target, in millions, as
    {"count", "phrase"} plus, where it states classes, "classes", "summed",
    "terms" and "excluded" (or "why" there is no count); None where it states
    none. `evidence` is every document of the row, read for what each class
    receives, and `classes` the target's classes they state (stated_shares);
    the document itself where they are not given.

    A class statement the consideration resolves is the count, the one stated
    most often (the largest of those tied): the classes, each judged on what
    it receives. Without one, the single counts that pass (_SHARES, as
    parse_shares has read them since the option counts were passed over) are
    the candidates, those that name the target before those that name no one.
    Where the document states the target's classes, a single count of one
    class is not a candidate, and neither is a count of "common stock" where
    that is one of the classes: a total that names no class still is. Where
    the classes leave no count, and no total is stated, there is none, and
    the reading says why.
    """
    texts = tuple(evidence or [text])
    names = _names(company)
    statements = copy.deepcopy(_statements(text, names, texts))
    found: Counter = Counter()
    best: dict[float, dict] = {}
    named: set[float] = set()
    resolved: set[float] = set()
    failed = None
    everyone: set[str] = set(classes or ())
    for s in statements:
        everyone |= {c for c, _ in s["classes"]}
    class_counts = {round(n / 1e6, 3) for s in statements for _, n in s["classes"]}
    if statements:
        groups, excluded = _terms(texts)
        lettered = everyone - {"common"}
        for s in statements:
            labs = {c for c, _ in s["classes"]}
            missing = lettered - labs - set(excluded)
            if missing and not (len(missing) == 1 and "common" in labs):
                # A statement that leaves out a class another names is not
                # the whole count; "common stock" beside a lettered class may
                # stand for the one it leaves out (the voting common stock).
                continue
            r = _resolve(s["classes"], groups, excluded, offer)
            r["phrase"] = s["phrase"]
            if r["count"] is None:
                failed = failed or r
                continue
            found[r["count"]] += 1
            best.setdefault(r["count"], r)
            resolved.add(r["count"])
        if failed is None and not found:
            failed = {"count": None, "phrase": statements[0]["phrase"], "classes": [{"class": c, "count": round(n / 1e6, 3)} for c, n in statements[0]["classes"]],
                      "why": "the filing states " + ", ".join(_class_name(c) for c in sorted(everyone)) + " outstanding and no one sentence states them all"}
    for m in _SHARES.finditer(text):
        v = float(m.group(1).replace(",", "")) / 1e6
        gap = m.group("gap")
        own = _SECOND_COUNT.split(gap, 1)[0]
        lead = text[max(0, m.start() - 60):m.start()]
        if v < 0.1 or not outstanding_count(gap) or _OF_WHICH.search(own) or re.search(r"\bof\s+which\b", gap, re.I) or _PARTITIVE.search(gap) or ":" in own \
                or (own != gap and re.search(r"\bissued\s+and\s*$", own, re.I)) or _NOT_ALL.match(text[m.end():m.end() + 60]) or text[m.end():m.end() + 2].lstrip().startswith(":") or _LED_END.search(lead) or _AUTHORIZED_LEAD.search(lead):
            continue
        desc = m.group(0)[len(m.group(1)):]
        e = _DESC_END.search(desc)
        desc = desc[:e.start()] if e else desc
        issuer = _issuer(desc)
        if not _is_target(issuer, names, texts, generic_company=bool(re.search(r"\bCompany", desc))):
            continue
        if everyone and (_labels(desc) or "common" in everyone or _UNIT_NOUN.search(desc) or not _TOTAL_NOUN.search(desc)
                         or round(v, 3) in class_counts):
            # Beside the target's classes, a count is the total only where it
            # names the stock or the Shares, not units, and is not one class's.
            continue
        v = round(v, 6)
        found[v] += 1
        best.setdefault(v, {"count": v, "phrase": _flat(m.group(0))})
        if issuer or re.search(r"\b(?:our|its|Company|Company’s|Company's)\b", desc):
            named.add(v)
    if resolved:
        # The target's classes, each judged on what it receives, are the
        # count: a single figure beside them may include a class the merger
        # does not buy (Baldwin's "140,242,358 shares of Baldwin’s common
        # stock" counts the Class B cancelled without consideration).
        found = Counter({v: c for v, c in found.items() if v in resolved})
    elif named:
        # A count the document ties to the target (its name, a short name of
        # it, "our" or "the Company") is preferred to one that names no one,
        # however often the unnamed is stated: an unnamed count can be any
        # party's, or no count of shares at all.
        found = Counter({v: c for v, c in found.items() if v in named})
    if not found:
        return failed
    top = found.most_common(1)[0][1]
    return best[max(k for k, c in found.items() if c == top)]


def stated_shares(texts: list[str], company: str | tuple[str, ...] | None = None, offer: float | None = None) -> dict | None:
    """
    The share count a row's documents state, read as read_shares reads one:
    the first document, in their order, that gives a count, every document
    read for what each class receives and for the target's classes (so a
    cover that names one class does not stand for a company the proxy shows
    has two). None stated: the first reading that says why, else None.
    """
    texts = tuple(texts)
    names = _names(company)
    classes: set[str] = set()
    for t in texts:
        for s in _statements(t, names, texts):
            classes |= {c for c, _ in s["classes"]}
    failed = None
    for t in texts:
        r = read_shares(t, company=names, evidence=texts, classes=classes, offer=offer)
        if r and r.get("count"):
            return r
        failed = failed or r
    return failed


# ── company names ────────────────────────────────────────────────────────────

#: a corporate suffix anywhere in the name marks a firm rather than a person
_INDIVIDUAL = re.compile(r"\b(LLC|L\.?L\.?C\.?|L\.?P\.?|LP|INC\.?|CORP\.?|CORPORATION|INCORPORATED|LTD\.?|LIMITED|PLC|HOLDINGS?|PARTNERS|FUND|CAPITAL|GROUP|COMPANY|CO\.?|S\.?A\.?|N\.?V\.?|A\.?G\.?|GMBH|TRUST|MANAGEMENT|INVESTORS|INVESTMENTS?|ACQUISITIONS?|PARTNERSHIP|VENTURES|ASSOCIATES|ADVISORS|ADVISERS|SARL|S\.?R\.?L\.?|B\.?V\.?|KK|K\.K\.|PTE|BHD|OY|AB|AS|ASA|SE|GP|LLP|FOUNDATION|BANK|SPV)\b", re.I)
#: the vehicle a buyout is run through, which is never the buyer a page names
_SHELL = re.compile(r"MERGER\s*SUB|ACQUISITION\s*(?:SUB|CORP|CO\b|VEHICLE)|\bPARENT\b|HOLDCO|TOPCO|MIDCO|BIDCO|INTERMEDIATE|NEWCO|\bSUB\b", re.I)
_NAMED = re.compile(r"\b(?:CAPITAL|MANAGEMENT|PARTNERS|GROUP|CORP|CORPORATION|INC|HOLDINGS|COMPANY|PLC|S\.A\.|N\.V\.|A\.G\.|LTD|LIMITED)\b", re.I)
_SUFFIX = re.compile(r"[,\s]+(?:inc|corp|corporation|co|company|ltd|limited|plc|llc|lp|l\.p|holdings?|group|sa|s\.a|nv|n\.v|ag|a\.g|gmbh|se|ab|oy|pte|bhd)\.?$", re.I)


def is_firm(name: str) -> bool:
    """Whether a name carries a corporate suffix anywhere: a firm rather than a person."""
    return bool(_INDIVIDUAL.search(name or ""))


def is_vehicle(name: str) -> bool:
    """Whether a name is the merger vehicle rather than whoever is behind it."""
    return bool(_SHELL.search(name or ""))


def norm_name(name: str | None) -> str:
    """A company name reduced for comparison: corporate suffixes, punctuation and case gone."""
    n = re.sub(r"[’']", "", name or "").strip().rstrip(".,")
    for _ in range(3):
        n = _SUFFIX.sub("", n).strip().rstrip(".,")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", n.lower())).strip()


def same_company(a: str | None, b: str | None) -> bool:
    """Whether two names are the same company: 'HUDSON LTD.' is 'Hudson Ltd', and 'Axonics' is 'Axonics, Inc.'."""
    na, nb = norm_name(a), norm_name(b)
    if not na or not nb:
        return False
    if na == nb or na.startswith(nb + " ") or nb.startswith(na + " "):
        return True
    fa, fb = na.split()[0], nb.split()[0]
    return len(fa) > 3 and fa == fb and (len(na.split()) == 1 or len(nb.split()) == 1)


def acquirer_of(buyers: list[str], target_name: str | None = None) -> str | None:
    """
    The buyer a page names: a firm rather than an individual, the sponsor or
    parent rather than its merger vehicle, and never the target. On a 13E-3
    the target is itself a filer on the statement, so it would otherwise win
    the ranking outright and the page would read that Hudson bought Hudson.
    """
    ranked = []
    for i, b in enumerate(buyers or []):
        if not _INDIVIDUAL.search(b):
            continue
        if target_name and same_company(b, target_name):
            continue
        if _SHELL.search(b):
            rank = 3
        elif _NAMED.search(b):
            rank = 1
        else:
            rank = 2
        ranked.append((rank, i, b))
    if not ranked:
        return None
    return sorted(ranked)[0][2]


def pretty(name: str | None) -> str:
    """'VAPOTHERM INC' to 'Vapotherm Inc'; a name already in mixed case is left alone; short vowelless words stay upper (SLR, LKCM)."""
    if not name:
        return ""
    if name != name.upper():
        return name
    out = []
    for w in name.split():
        core = re.sub(r"[^A-Za-z]", "", w)
        # A dotted acronym (S.I., N.V.) and a numbered vehicle (Fund VII) are
        # not words and take no case.
        if core.upper() in ("LLC", "LP", "LLP", "PLC", "AG", "NV", "SA", "GP", "BV", "SE", "USA", "US", "UK") or re.fullmatch(r"(?:[A-Za-z]\.){2,},?", w) or re.fullmatch(r"[IVXL]+[.,]?", core.upper() and w.upper()) or (core and not re.search(r"[AEIOUY]", core.upper())):
            out.append(w.upper())
        else:
            # capitalize() would lower-case the first letter of "(JERSEY)",
            # which opens with a bracket rather than a letter.
            lw = w.lower()
            i = next((j for j, ch in enumerate(lw) if ch.isalpha()), None)
            out.append(lw if i is None else lw[:i] + lw[i].upper() + lw[i + 1:])
    return " ".join(out)


#: Words that only appear in a sentence, never in a company name. A parser that
#: reaches past the parties captures the clause after them, and the result reads
#: as a name until you notice it has a verb in it.
_CLAUSE = re.compile(r"\b(will|shall|would|agreed|pursuant|whereby|thereof|hereby|receive|assume|merge)\b", re.I)
_SUFFIXES = re.compile(r"\b(incorporated|inc|corporation|corp|company|co|limited|ltd|llc|lp|llp|plc|holdings|holding|group|the)\b", re.I)


def is_clause(name: str) -> bool:
    """True where a parsed party is really a fragment of the sentence around it."""
    return bool(_CLAUSE.search(name)) or len(name.split()) > 9 or name.rstrip().endswith(".") and len(name.split()) > 5


def same_registrant(a: str, b: str) -> bool:
    """
    Two names for one company, as EDGAR writes them.

    EDGAR appends a filer's state and abbreviates its suffix, so "HUNTINGTON
    BANCSHARES INC /MD/" and "Huntington Bancshares Incorporated" are the same
    registrant and must not read as buyer and seller.
    """
    def norm(v: str) -> str:
        v = re.sub(r"/[A-Z]{2}/?", " ", v or "")
        v = _SUFFIXES.sub(" ", v)
        return re.sub(r"[^a-z0-9]+", "", v.lower())

    x, y = norm(a), norm(b)
    return bool(x) and bool(y) and (x == y or x.startswith(y) or y.startswith(x))


# ── the acquirer, from the merger agreement sentence ─────────────────────────

_AMONG = re.compile(r"Agreement and Plan of Merger\b[^\n]{0,240}?\bby and (?:among|between)\b(.{0,420})", re.I | re.S)
#: a corporate name ends in one of these, so a period after one is not a full stop
_ABBR = re.compile(r"\b(?:Inc|Corp|Co|Ltd|Cos|Bros|Mfg|Nos?|St|Jr|Sr|L\.P|N\.V|S\.A|A\.G|B\.V|S\.p\.A|U\.S|A|B|C|I{1,3}|IV|V)\.$")
#: the merger vehicle, which is never the buyer a page names
_VEHICLE = re.compile(r"\bMerger\s+Sub\b|\bAcquisition\s+Sub\b|\bMerger\s+Co\b|\bMerger\s+Subsidiary\b|\bMerger\s+Partnership\b|\bMerger\s+LLC\b", re.I)
#: a defined term standing in for a name tells us nothing about who is buying
_DEFINED = re.compile(r"^(?:the\s+)?(?:Company|Parent|Buyer|Purchaser|Acquiror|Acquirer|Holdco|Holdings|Topco|Bidco|Newco|Merger\s+Sub|Surviving\s+\w+)$", re.I)
#: the corporate suffixes acquirer_of looks for in a 13E-3 filer list
_FIRM = re.compile(r"\b(LLC|L\.?L\.?C\.?|L\.?P\.?|LP|INC\.?|CORP\.?|CORPORATION|LTD\.?|LIMITED|PLC|HOLDINGS?|PARTNERS|GROUP|COMPANY|CO\.?|S\.?A\.?|N\.?V\.?|A\.?G\.?|GMBH|S\.?E\.?|AB|OY|ASA|BANK|TRUST|SPA|S\.P\.A\.?|PTE|BHD|KK)\b", re.I)
_CONNECTIVE = {"&", "of", "and", "the", "de", "van", "der", "für", "du"}


def _cut_sentence(seg: str) -> str:
    """The party list up to the first real full stop; a period closing a corporate abbreviation is not one."""
    for m in re.finditer(r"\.\s", seg):
        head = seg[: m.start() + 1]
        if _ABBR.search(head.rstrip()):
            continue
        return head
    return seg


def parse_parties(seg: str) -> list[str]:
    """
    The named parties of one "by and among" clause. Parentheticals and the
    ", a Delaware corporation" appositives go first, because both carry commas
    and the word "and" that the split would otherwise trip on.
    """
    s = re.sub(r"\s+", " ", _cut_sentence(seg))
    s = re.sub(r"\([^)]*\)", " ", s)
    s = re.sub(r",\s*an?\s+[^,]{0,90}?\b(?:corporation|company|limited liability company|partnership|association|bank|entity|subsidiary|trust|societas|société\w*|aktiengesellschaft|public limited)\b[^,]{0,80}", ",", s, flags=re.I)
    s = re.sub(r",\s*(?:each\s+)?a\s+(?:direct|indirect|wholly[- ]owned)[^,]{0,90}", ",", s, flags=re.I)
    parts = [p.strip(" ,;:") for p in re.split(r",|\band\b", s) if p.strip(" ,;:")]
    out: list[str] = []
    for p in parts:
        # "Bolt Merger Sub" then "Inc." arrives as two pieces of one name.
        if out and re.fullmatch(r"(?:Inc|Corp|Corporation|Co|Ltd|Limited|LLC|L\.?P|LP|N\.V|S\.A|A\.G|B\.V|plc|PLC|GmbH)\.?", p, re.I):
            out[-1] = f"{out[-1]}, {p}"
            continue
        if len(p) > 90 or not re.match(r"[A-Z0-9“\"]", p):
            continue
        # A removed parenthetical leaves the full stop that closed it behind.
        out.append(re.sub(r"\s+\.\s*$", "", re.sub(r"\s+", " ", p)).strip(" ,;:"))
    return out


def named_party(p: str) -> bool:
    """
    Whether a piece of the clause names a company. A corporate suffix settles
    it; where there is none the name still counts if every word of it opens
    like a name, because "Johnson & Johnson" carries no suffix and is
    nonetheless who bought Ambrx. A defined term, a merger vehicle or the
    sentence that follows the parties is not a name.
    """
    p = p.strip()
    if not p or _VEHICLE.search(p) or _DEFINED.match(p):
        return False
    if _FIRM.search(p):
        return True
    words = p.split()
    return len(words) >= 2 and all(w in _CONNECTIVE or re.match(r"[A-Z0-9“\"]", w) for w in words)


#: the defined term a merger agreement gives its vehicle, right after the name:
#: 'ALTA Acquisition Corp. (“Merger Sub”)'. Whatever the name, that party is the
#: vehicle and not the buyer, and the party listed before it is its parent.
_VEHICLE_TERM = re.compile(r"\s*,?\s*\(\s*(?:the\s+)?[“\"]?\s*(?:Merger\s+Sub(?:sidiary)?|Acquisition\s+Sub|Merger\s+Co|Purchaser|Sub|Acquiror\s+Sub)\s*[”\"]?\s*\)", re.I)


def _defined_vehicle(seg: str, party: str) -> bool:
    """Whether the agreement sentence defines this party as its merger vehicle."""
    for name in (party, party.split(",")[0].strip()):
        at = seg.find(name)
        if at >= 0:
            rest = seg[at + len(name):at + len(name) + 80]
            rest = re.sub(r"^\s*,?\s*(?:Inc|Corp|Corporation|LLC|Ltd|L\.P)\.?", "", rest)
            return bool(_VEHICLE_TERM.match(rest))
    return False


def vehicle_parent(sentence: str, vehicle: str, target_name: str) -> str | None:
    """
    The buyer behind a merger vehicle a stored row named as its acquirer: the
    party the agreement sentence lists immediately before the vehicle, where
    that is a named company and not the target. Anything less certain is None.
    """
    m = _AMONG.search(sentence)
    if not m:
        return None
    parties = parse_parties(m.group(1))
    idx = next((i for i, p in enumerate(parties) if p.strip(" ,;:") == vehicle.strip(" ,;:") or p.startswith(vehicle.split(",")[0])), None)
    if not idx:
        return None
    p = parties[idx - 1]
    if same_company(p, target_name) or _DEFINED.match(p.strip()) or _VEHICLE.search(p) or is_vehicle(p) or shell_name(p) or not re.match(r"[A-Z0-9]", p.strip()):
        return None
    return _clean_party(p)


def _clean_party(p: str) -> str:
    """'Synopsys, Inc., Inc.' (a suffix the clause split counted twice) to 'Synopsys, Inc.'."""
    return re.sub(r"(,\s*(?:Inc|Corp|Corporation|LLC|Ltd|L\.?P)\.?)(?:,\s*(?:Inc|Corp|Corporation|LLC|Ltd|L\.?P)\.?)+$", r"\1", p.strip(" ,;:"))


def parse_acquirer(text: str, target_name: str) -> tuple[str | None, str | None]:
    """
    The buyer, from the merger agreement sentence: the first named party that
    is neither the target nor a merger vehicle. A proxy that names its parties
    only by defined term ("by and among Parent, Merger Sub and the Company")
    yields nothing, and nothing is what it returns; a guess here would be a
    made-up acquirer on a banker's page.
    """
    for m in list(_AMONG.finditer(text))[:40]:
        parties = parse_parties(m.group(1))
        if len(parties) < 2:
            continue
        seg = re.sub(r"\s+", " ", m.group(1))
        vehicle = [_defined_vehicle(seg, p) for p in parties]
        for i, p in enumerate(parties):
            if vehicle[i] or same_company(p, target_name):
                continue
            # A name with no corporate suffix ("Synopsys") is still the buyer
            # where the agreement lists its merger vehicle straight after it.
            parent = i + 1 < len(parties) and vehicle[i + 1] and not _DEFINED.match(p.strip()) and re.match(r"[A-Z0-9]", p.strip())
            if not (named_party(p) or parent):
                continue
            sentence = re.sub(r"\s+", " ", _cut_sentence(m.group(0))).strip()
            return _clean_party(p), sentence[:400]
    return None, None


def acquirer_side(text: str) -> bool:
    """
    Whether the filer is the buyer rather than the target, which is why the
    proxy carries no price for its own holders: they are voting to issue
    shares, not to be bought out. Order of the parties in the agreement
    sentence proves nothing here (a target names itself first as often as
    not), so the test is the proposal put to the meeting, and the language a
    target-side proxy always carries instead settles a document holding both.
    """
    issuance = len(re.findall(r"\b(?:[Ss]hare|[Ss]tock)\s+[Ii]ssuance\s+[Pp]roposal\b|\bto approve the issuance of shares\b", text))
    if not issuance:
        return False
    return not re.search(r"converted into the right to receive", text, re.I)


#: words that open many company names and name none of them on their own
_GENERIC_FIRST = {"first", "american", "united", "national", "general", "new", "global", "international", "capital", "the", "north", "south", "east", "west", "great", "pacific", "atlantic", "central", "western", "eastern", "southern", "northern", "community", "citizens", "peoples", "home", "us", "u s", "china", "bank", "royal", "standard", "republic", "federal", "liberty", "union", "allied", "advanced", "applied", "digital", "premier", "summit", "pioneer", "heritage"}
_PRONOUNS = {"we", "us", "our", "ours", "it", "its"}
#: a company named in running text: up to six capitalised words, "&", "of", "and" between them
_CO = r"((?:the\s+)?[A-Z][\w&.\-’']*(?:\s+(?:&|of|and|[A-Z][\w&.\-’']*)){0,5})"
_ACQUIRES = re.compile(_CO + r"\s+(?:will|would|has\s+agreed\s+to|agreed\s+to|is\s+to|proposes\s+to)\s+acquire\s+(?:all\s+(?:of\s+)?)?(?:the\s+)?(?:issued\s+and\s+)?(?:outstanding\s+)?(?:[a-z\s]{0,30}?(?:shares|stock|interests?|units)\s+of\s+)?" + _CO)
#: an exchange ratio paid in the issuer's shares: 'exchanged for 15.235 registered shares of Transocean'
_ISSUED = re.compile(r"(?:exchanged\s+for|converted\s+into\s+the\s+right\s+to\s+receive|right\s+to\s+receive)\s+(?:approximately\s+)?\d+\.\d{2,6}\s+(?:of\s+an?\s+)?(?:registered\s+|newly\s+issued\s+|fully\s+paid\s+|validly\s+issued\s+)*(?:ordinary\s+|common\s+)?shares?\s+of\s+" + _CO)
#: the company whose holders are paid: 'each Valaris Share ... exchanged for', 'each share of common stock ... of the Company ... converted into the right to receive'
_HOLDERS_PAID = [
    re.compile(r"\beach\s+(?:issued\s+and\s+outstanding\s+|outstanding\s+)?(?:share\s+of\s+)?" + _CO + r"\s+(?:[Cc]ommon\s+|[Oo]rdinary\s+|[Cc]lass\s+[A-C]\s+)?(?:[Ss]hares?|[Ss]tock|[Uu]nits?)\b[^.;]{0,240}?(?:converted\s+into|exchanged\s+for|right\s+to\s+receive)"),
    re.compile(r"\beach\s+(?:issued\s+and\s+outstanding\s+|outstanding\s+)?(?:share|unit)\s+of\s+(?:[Cc]ommon|[Cc]lass\s+[A-C]|[Oo]rdinary)[^.;]{0,80}?\bof\s+" + _CO + r"[^.;]{0,200}?(?:converted\s+into|exchanged\s+for|right\s+to\s+receive)"),
    re.compile(_CO + r"(?:’s|'s)?\s+(?:stockholders|shareholders|unitholders)\s+will\s+(?:be\s+entitled\s+to\s+)?receive\s+(?:US)?\$\s?\d"),
]
#: what puts an acquisition statement inside this deal rather than in the filer's history
_THIS_DEAL = re.compile(r"pursuant\s+to\s+which|[Mm]erger\s+[Aa]greement|[Bb]usiness\s+[Cc]ombination|[Aa]rrangement|[Tt]ransaction\s+[Aa]greement|the\s+(?:proposed\s+)?(?:acquisition|merger|transaction)\b|[Aa]t\s+the\s+closing|[Ee]ffective\s+[Tt]ime")
_PROSPECTUS_OF = re.compile(r"\bPROSPECTUS\s+OF\s+" + r"((?:THE\s+)?[A-Z][A-Z0-9&.,\-’' ]{2,80}?)(?=\s*(?:\n|FOR\b|RELATING\b|PROXY\b|\(|$))|\b[Pp]rospectus\s+of\s+" + _CO)
_SUBJECT_HEADER = re.compile(r"SUBJECT COMPANY:\s*COMPANY DATA:\s*COMPANY CONFORMED NAME:\s*([^\n]+)")


_REGISTRANT = re.compile(r"\(\s*(?:Exact\s+)?[Nn]ame\s+of\s+(?:[Rr]egistrant|[Cc]ompany)\s+[Aa]s\s+[Ss]pecified\s+[Ii]n\s+[Ii]ts\s+[Cc]harter\s*\)")


def cover_registrant(text: str) -> str | None:
    """
    The registrant's name as the proxy's cover prints it, which is its name on
    the day it filed. EDGAR's own name is today's: Memorial Resource
    Development files under 'Range Resources - Louisiana, Inc.' now, FLIR
    under 'Teledyne FLIR, LLC', and read against today's name the target's
    proxy would look like the buyer's.
    """
    m = _REGISTRANT.search(text[:30_000])
    if not m:
        return None
    lines = [ln.strip() for ln in text[max(0, m.start() - 300): m.start()].splitlines() if ln.strip()]
    if not lines:
        return None
    name = re.sub(r"^.*(?:☒|☐|☑|\[\s*[xX]?\s*\])\s*", "", lines[-1]).strip(" ,")
    return name if 2 <= len(name) <= 120 and re.search(r"[A-Za-z]", name) else None


def filer_aliases(text: str, name: str) -> set[str]:
    """
    The names a proxy calls its own registrant by: the EDGAR name without its
    suffix, the terms it defines for itself on first mention ('Transocean
    Ltd. (“Transocean”)', '(“we,” “Victory,” or “Victory Capital”)'), and the
    first word where that word names one company and not a hundred.
    """
    base = norm_name(re.sub(r"/[A-Z]{2}/?", " ", name or ""))
    out = {base} if base else set()
    words = base.split()
    if len(words) > 1 and words[0] not in _GENERIC_FIRST and len(words[0]) >= 4:
        # The first word alone stands for the company only as a whole name:
        # "Symmetry Surgical" is the spin-off, not Symmetry Medical.
        out.add(words[0] + "$")
    if len(words) > 2:
        out.add(" ".join(words[:2]))
    head = text[:120_000]
    if base:
        pat = r"\s+".join(re.escape(w) for w in base.split()) + r"[^()]{0,20}?\(([^()]{1,160})\)"
        for m in list(re.finditer(pat, head, re.I))[:5]:
            for term in re.findall(r"[“\"]\s*([^”\"]{1,40}?)\s*[”\"]", m.group(1)):
                t = norm_name(term)
                # its own short name ("Transocean", "Victory Capital"), its
                # initials ("CQH" for Cheniere Energy Partners LP Holdings) or
                # "the Company"; not "the combined company", nor another
                # party's term defined in the same parenthesis
                acronym = term.strip().isupper() and len(term.strip()) <= 6 and term.strip()[0].lower() == base[0]
                if t and t not in _PRONOUNS and (t.split()[0] == words[0] or t == "company" or acronym):
                    out.add(t)
    # A first word the document defines for another company is that
    # company's: "The Williams Companies, Inc. (“Williams”)" in Williams
    # Partners' proxy, "Cheniere Energy, Inc. (“Cheniere”)" in CQH's.
    for m in _DEFINES.finditer(head):
        full, t = norm_name(m.group(1)), norm_name(m.group(2))
        if t and full and base not in full and full not in base:
            out.discard(t + "$")
            if t == (words[0] if words else None):
                out.discard(t)
    return {a for a in out if a}


#: a company and the term the document defines for it: 'Transocean Ltd. (“Transocean”)'
_DEFINES = re.compile(r"((?:[Tt]he\s+)?[A-Z][\w&.\-’']*(?:\s+(?:&|of|and|[A-Z][\w&.,\-’']*)){0,6})\s*\(\s*(?:the\s+|together\s+with\s+its\s+subsidiaries,\s+)?[“\"]\s*([^”\"]{1,40}?)\s*[”\"]")


def _is(alias: set[str], captured: str) -> bool:
    n = norm_name(re.sub(r"^the\s+", "", captured.strip(), flags=re.I))
    if not n:
        return False
    # A whole alias, or one followed by the noun it qualifies ("Transocean
    # Shares", "Great Plains Energy. It"); a bare first word only exactly.
    return any(n == a[:-1] if a.endswith("$") else (n == a or n.startswith(a + " ")) for a in alias)


def filer_is_buyer(text: str, name: str) -> dict | None:
    """
    Whether the registrant whose proxy this is buys rather than is bought, in
    a joint proxy where the test acquirer_side applies (an issuance proposal,
    no 'converted into the right to receive') cannot tell: both companies'
    holders vote, and the target's shares are described converting. A joint
    proxy/prospectus names the company issuing the shares, and the issuer is
    the buyer:

      - the cover's 'PROSPECTUS OF X' (the registrant on the buyer's S-4),
      - 'X will acquire all of the issued and outstanding shares of Y',
      - 'each Y share ... exchanged for 15.235 registered shares of X',
      - the SUBJECT COMPANY of the submission header, where the document
        carries one and it is another company.

    The registrant is the buyer when one of those names it as the issuer or
    acquirer and nothing in the document names it as the company acquired, or
    as the company whose shares are converted or exchanged. Returns the
    evidence, or None. Transocean's proxy for Valaris and Victory Capital's
    for First Eagle are the cases.
    """
    alias = filer_aliases(text, cover_registrant(text) or name)
    if not alias:
        return None
    head = text[:150_000]
    buyer: list[str] = []
    bought: list[str] = []
    for m in _PROSPECTUS_OF.finditer(head[:30_000]):
        who = m.group(1) or m.group(2) or ""
        (buyer if _is(alias, who) else bought).append(f"prospectus of {who.strip()[:60]}")
    for m in _ACQUIRES.finditer(head):
        if _is(alias, m.group(2)):
            bought.append(re.sub(r"\s+", " ", m.group(0))[:120])
        elif _is(alias, m.group(1)) and m.start() < 40_000 and _THIS_DEAL.search(_clause(head, m.start()) if False else head[max(0, m.start() - 300): m.end() + 300]):
            buyer.append(re.sub(r"\s+", " ", m.group(0))[:120])
    for m in _ISSUED.finditer(head):
        if _is(alias, m.group(1)):
            buyer.append(re.sub(r"\s+", " ", m.group(0))[:120])
    for pat in _HOLDERS_PAID:
        for m in pat.finditer(text):
            if _is(alias, m.group(1)):
                bought.append(re.sub(r"\s+", " ", m.group(0))[:120])
                break
    sub = _SUBJECT_HEADER.search(text[:20_000])
    if sub:
        (bought if _is(alias, sub.group(1)) else buyer).append(f"subject company {sub.group(1).strip()[:60]}")
    if buyer and not bought:
        return {"evidence": buyer[:3]}
    return None


# ── the buyer type, the way the deck index cuts it ───────────────────────────

_SPONSOR = re.compile(r"\bPartners\b|\bCapital\b|\bHoldings\s+L\.?P\.?\b|\bManagement\b|\bEquity\b|\bAdvisors?\b|\bAdvisers?\b|\bInvestments?\b|\bFund\b", re.I)
#: a vehicle name, which names a buyer without naming who is behind it
_HOLDCO = re.compile(r"\bParent\b|\bHoldco\b|\bTopco\b|\bBidco\b|\bMidco\b|\bNewco\b|\bAggregator\b|\bMerger\b|\bBuyer\b|\bPurchaser\b|\bAcquisition\s+(?:Sub|Vehicle)\b", re.I)
_OPERATING = re.compile(r"\bBank\b|\bBancorp\b|\bBancshares\b|\bPharmaceuticals?\b|\bTherapeutics\b|\bTechnologies\b|\bSystems\b|\bIndustries\b|\bEnergy\b|\bMedical\b|\bHealth\b|\bSoftware\b|\bSemiconductor\b|\bAirlines\b|\bStores\b|\bFoods?\b|\bMotors?\b|\bCommunications\b|\bNetworks\b|\bLaboratories\b|\bResources\b|\bMaterials\b|\bInsurance\b", re.I)


def classify_buyer(acquirer: str | None) -> str:
    """
    Financial sponsor or strategic, from the acquirer's name, the way the deck
    index cuts a 13E-3 buyer group. A name built out of "Partners", "Capital",
    "Management" or "Equity" with no operating business in it reads as a
    sponsor; a name that is only a vehicle says nothing about who is behind it
    and stays Unclassified rather than being guessed at. A sponsor whose own
    name gives nothing away (KKR & Co.) will read as strategic, which is the
    limit of what a name can tell you.
    """
    name = (acquirer or "").strip()
    if not name:
        return "Unclassified"
    if _HOLDCO.search(name):
        return "Unclassified"
    if _SPONSOR.search(name) and not _OPERATING.search(name):
        return "Financial sponsor"
    return "Strategic"


# ── what is not a precedent transaction ──────────────────────────────────────

#: a blank-check shell by name alone, which costs no request to see
_SHELL_NAME = re.compile(r"\bAcquisition\s+(?:Corp|Corporation|Company|Co)\b\.?|\bAcquisition\s+Holdings?\b|\bMerger\s+Corp\b|\bBlank\s+Check\b", re.I)
#: the wider shell vocabulary, only trusted once EDGAR's SIC says blank check
_SHELLISH = re.compile(r"\bAcquisition\b|\bCapital\s+Corp\b|\bSPAC\b|\bMerger\s+Corp\b", re.I)
_ROMAN = re.compile(r"[\s.]((?:I{1,3}|IV|VI{0,3}|IX|XI{0,2}))[\s.,]*$")


def shell_name(name: str) -> bool:
    """
    Whether a filer's name alone marks it a blank-check shell. A de-SPAC vote
    is filed on DEFM14A by the SPAC, so the name on the index line is the
    shell's own, and an operating company is essentially never called
    "... Acquisition Corp". A Roman numeral on the end is the other tell:
    sponsors number their vehicles.
    """
    n = (name or "").strip()
    if not n:
        return False
    if _SHELL_NAME.search(n):
        return True
    return bool(_ROMAN.search(n)) and bool(re.search(r"\bAcquisition\b|\bCapital\b", n, re.I))


def shellish(name: str) -> bool:
    """The wider shell vocabulary, for a filer EDGAR has already coded blank-check."""
    return bool(_SHELLISH.search(name or ""))


#: What only a de-SPAC proxy says: the shell holds its IPO money in a trust
#: account, its public holders may redeem from it, and the merger is its
#: "initial business combination". A strategic buyer's merger subsidiary called
#: "ALTA Acquisition Corp." says none of it. Measured on 4,262 stored proxies:
#: the real de-SPACs mention a trust account 133 to 420 times; ordinary deals
#: rarely more than a dozen (a bank's trust department, a company that was
#: itself once a SPAC: Heliogen 6, Lionsgate Studios 6, HWH 28), with Student
#: Loan Corp's 86 mentions of loan trusts the highest, and none of those names
#: the shell's business combination or a blank-check company more than a few
#: times. So both must be present, at counts no stray reference reaches.
SPAC_TRUST_MIN = 100
SPAC_IBC_MIN = 5


def spac_evidence(text: str) -> dict[str, int]:
    """How often a document uses the words only a blank-check combination uses."""
    return {
        "trustAccount": len(re.findall(r"trust\s+account", text, re.I)),
        "initialBusinessCombination": len(re.findall(r"initial\s+business\s+combination", text, re.I)),
        "blankCheck": len(re.findall(r"blank[\s-]check", text, re.I)),
        "specialPurpose": len(re.findall(r"special\s+purpose\s+acquisition|\bSPAC\b", text, re.I)),
    }


def is_despac(evidence: dict[str, int]) -> bool:
    """A de-SPAC on the document's own evidence: a trust account and the shell's business combination, never a name."""
    return evidence.get("trustAccount", 0) >= SPAC_TRUST_MIN and (
        evidence.get("initialBusinessCombination", 0) >= SPAC_IBC_MIN or evidence.get("blankCheck", 0) >= SPAC_IBC_MIN or evidence.get("specialPurpose", 0) >= SPAC_IBC_MIN
    )


#: the share of the public company the private company's holders must take
REVERSE_MERGER_MIN = 60
_PRIVATE = re.compile(r"privately[\s-]held|private\s+(?:company|biotechnology\s+company|operating\s+company)", re.I)
_HOLDERS = r"(?:stockholders|shareholders|equityholders|equity\s+holders|securityholders|security\s+holders|unitholders)"
_STAKE = r"(?:will|would|are\s+expected\s+to|is\s+expected\s+to|are\s+anticipated\s+to)\s+(?:collectively\s+|in\s+the\s+aggregate\s+)?own[^.;%]{0,60}?(\d{1,2}(?:\.\d+)?)\s?%"
_CURRENT = re.compile(r"(?:current|existing|pre-merger|pre-closing)\s+(?:[A-Z][\w&.\-’' ]{1,40}?\s+)?" + _HOLDERS + r"[^.;%]{0,120}?" + _STAKE)
_OTHER = re.compile(r"(?:former\s+)?(?:[A-Z][\w&.\-]{1,30}(?:’s|'s)\s+|" + _HOLDERS + r"\s+of\s+[A-Z][\w&.\-]{1,30}\s+)" + r"(?:" + _HOLDERS + r"\s+)?(?:[^.;%]{0,80}?)" + _STAKE)


def reverse_merger_evidence(text: str) -> dict | None:
    """
    A reverse merger on the proxy's own words: one sentence in which the
    public company's current holders keep a minority of it and another
    company's holders take the majority ("MabVax's equityholders will own
    approximately 95%, and Telik's current equityholders will own
    approximately 5%, of the Telik capital stock"). A control acquisition says
    the opposite: the target's holders, "former" holders, take a minority of
    the buyer's shares, and the buyer's current holders keep the majority.
    """
    # The incoming holders own a private company: a merger of two listed
    # companies ("CBC's current shareholders ... 42% ... SCB's shareholders
    # ... 58%", Six Flags and Cedar Fair at 48.8% and 51.2%) is a merger of
    # equals or a stock acquisition, not a reverse merger.
    if not _PRIVATE.search(text):
        return None
    for sentence in re.split(r"(?<=[.;])\s+", text):
        if "own" not in sentence or "%" not in sentence:
            continue
        cur = _CURRENT.search(sentence)
        if not cur or float(cur.group(1)) >= 50:
            continue
        others = [float(m.group(1)) for m in _OTHER.finditer(sentence) if m.start() != cur.start() and not (cur.start() <= m.start() < cur.end())]
        if any(v >= REVERSE_MERGER_MIN for v in others):
            return {"currentHolders": float(cur.group(1)), "newHolders": max(v for v in others if v >= REVERSE_MERGER_MIN), "excerpt": re.sub(r"\s+", " ", sentence).strip()[:400]}
    return None


# ── the class of securities a tender offer seeks ─────────────────────────────

_TITLE = re.compile(r"([^()]{0,240}?)\(\s*Title\s+of\s+Class(?:es)?\s+of\s+Securities\s*\)", re.I)
#: the securities nouns a cover names, in the order they may lead a title
_NOUN = re.compile(r"\b(warrants?|notes?|debentures?|bonds?|rights?|preferred|common|ordinary|shares?|units?|American\s+Depositary)\b", re.I)
#: a preferred stock with dividend terms is a senior security, not the equity
_SENIOR_PREFERRED = re.compile(r"\d+(?:\.\d+)?\s?%|\bSeries\b|\bCumulative\b|\bRedeemable\b|\bPerpetual\b|\bConvertible\s+Preferred\b", re.I)


def securities_sought(text: str) -> dict | None:
    """
    The class of securities a Schedule TO or 13E-3 cover names, and what kind
    it is: {title, kind}, kind one of common, warrants, debt, preferred, rights.
    The kind is the class's leading noun: Direct Digital's "Warrants exercisable
    for Class A Common Stock" is a class of warrants. A preferred stock is
    "preferred" only with dividend terms (a rate, a series, cumulative,
    redeemable): NET Serviços's "Preferred Shares, no par value" are its listed
    equity, whose buyout is a take-private. None where the cover names no class.
    """
    m = _TITLE.search(text[:40_000])
    if not m:
        return None
    title = re.sub(r"\s+", " ", m.group(1)).strip(" ,;:")
    # The cover's line before the class is the subject company's name.
    title = re.split(r"\(Name of (?:Subject Company|Issuer|Filing Person)[^)]*\)|\(Issuer\)|\(Offeror\)", title)[-1].strip(" ,;:")
    lead = _NOUN.search(title)
    if not lead:
        return {"title": title[:200], "kind": "common"}
    noun = lead.group(1).lower()
    if noun.startswith("warrant"):
        kind = "warrants"
    elif noun.startswith(("note", "debenture", "bond")):
        kind = "debt"
    elif noun.startswith("right"):
        kind = "rights"
    elif noun == "preferred" or (re.search(r"\bpreferred\b", title, re.I) and not re.search(r"\bcommon\b|\bordinary\b", title[: lead.start() + 40], re.I) and noun.startswith(("share", "american"))):
        kind = "preferred" if _SENIOR_PREFERRED.search(title) else "common"
    else:
        kind = "common"
    return {"title": title[:200], "kind": kind}


#: the classes whose purchase is not a control acquisition of the company
NOT_CONTROL = {"warrants": "warrants", "debt": "notes or debentures", "preferred": "preferred stock", "rights": "rights"}


def not_control_reason(sought: dict | None) -> str | None:
    """Why a tender for this class is no precedent: the offer is for a senior or derivative security, not the company's equity."""
    if not sought or sought.get("kind") not in NOT_CONTROL:
        return None
    return f"a tender offer for {NOT_CONTROL[sought['kind']]} ({sought['title'][:80]}), not a control acquisition"


def reject_reason(name: str, sic: str | None, sic_description: str | None) -> str | None:
    """Why a filer is not a precedent target, once EDGAR's industry code is known; None when it is one."""
    sic = str(sic or "")
    desc = (sic_description or "").upper()
    if sic == "6770" and (shellish(name) or "BLANK CHECK" in desc):
        return "blank-check shell"
    if sic == "6726":
        return "closed-end fund or trust"
    return None
