"""
Reading a merger filing: the pure functions, over text that is already fetched.

Nothing here touches the network or the disk, which is what makes each of these
answerable on its own. A filing states its own agreement date, its own price and
its own premiums; the work is telling those apart from the dozen other dollar
figures and percentages on the same page, and from the earlier proposals a proxy
recites in its background section.
"""

from __future__ import annotations

import re
from collections import Counter
from datetime import date

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


# ── the premiums ─────────────────────────────────────────────────────────────

_PREM = re.compile(
    r"(?:premiums?\s+of\s+(?:approximately|about|roughly|around)?\s*(\d{1,3}(?:\.\d+)?)\s?(?:%|percent)"
    r"|(?:an?\s+)?(?:approximately|about|roughly|around)?\s*(\d{1,3}(?:\.\d+)?)\s?(?:%|percent)\s+premiums?)"
    r"\s+(?:to|over|above|compared\s+to|compared\s+with|relative\s+to|on|based\s+on)\s+(?:the\s+|its\s+|that\s+|such\s+)?([^;.]{0,170})",
    re.I,
)
_DAYS = re.compile(r"(\d{1,3}|thirty|sixty|ninety)[- ](?:trading[- ]|calendar[- ])?days?", re.I)
_PRICE = re.compile(r"\$\s?(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)")


def _classify(basis: str) -> str | None:
    """Which reference price a premium sentence measures against."""
    b = basis.lower()
    b = re.split(r",?\s+and\s+(?:an?\s+)?(?:premium|approximately|about)|\(i{1,3}v?\)|\(v\)", b)[0]
    days = {d.lower() for d in _DAYS.findall(b)}
    days = {"30" if d == "thirty" else "60" if d == "sixty" else "90" if d == "ninety" else d for d in days}
    if re.search(r"(52|fifty[- ]two)[- ]week\s+(?:intraday\s+|closing\s+)?high", b):
        return "high52"
    if re.search(r"vwap|volume[- ]weighted", b):
        return "vwap30" if days == {"30"} else None
    if re.search(r"average|week|month|vwap|volume", b):
        return None
    if re.search(r"closing|last\s+(?:reported\s+)?(?:sale|trade|trading)|unaffected|close\s+of|price\s+on\s+[A-Z]|share\s+price\s+of", basis, re.I):
        return "1day"
    return None


def _stale(basis: str, announced: str | None) -> bool:
    """Whether a premium is measured to a date too far from the agreement to be this deal's."""
    if not announced:
        return False
    m = re.search(_DATE, basis)
    iso = iso_date(m.group(1), m.group(2), m.group(3)) if m else None
    if not iso:
        return False
    # A premium is measured to the last trading day before announcement, or to
    # the last unaffected day where the deal leaked a few weeks earlier. A
    # reference date older than that belongs to an earlier proposal.
    gap = (date.fromisoformat(announced) - date.fromisoformat(iso)).days
    return not -5 <= gap <= 21


def _refused(before: str, offer: float | None) -> bool:
    """Whether the words leading into a premium name a per-share price other than the one agreed."""
    if not offer:
        return False
    head = before[before.rfind(". ") + 1:]
    for m in _PRICE.finditer(head):
        try:
            v = float(m.group(1).replace(",", ""))
        except ValueError:
            continue
        if 0.05 <= v <= 10_000 and abs(v - offer) > 0.01 * offer:
            return True
    return False


def parse_premiums(text: str, offer: float | None = None, announced: str | None = None) -> dict[str, tuple[float, str]]:
    """
    The premiums the document states: {basis: (fraction, sentence)} for 1day,
    vwap30 and high52, the most often stated figure of each.

    A merger proxy recites, in its background section, the premium of every
    proposal that came before the one agreed. Those measure a price that was
    refused, against a date months before announcement, and they outnumber the
    real figure. So where the offer and the agreement date are known, a
    sentence that names a different price, or a reference date that is not
    just before the agreement, is left out.
    """
    found: dict[str, Counter] = {"1day": Counter(), "vwap30": Counter(), "high52": Counter()}
    sentence: dict[tuple[str, float], str] = {}
    for m in _PREM.finditer(text):
        raw = m.group(1) or m.group(2)
        try:
            v = round(float(raw) / 100, 4)
        except (TypeError, ValueError):
            continue
        if not 0 < v <= 3.0:
            continue
        kind = _classify(m.group(3))
        if not kind:
            continue
        if _stale(m.group(3), announced) or _refused(text[max(0, m.start() - 200):m.start()], offer):
            continue
        found[kind][v] += 1
        s = re.sub(r"\s+", " ", text[max(0, m.start() - 90):m.end()]).strip()
        if m.start() > 90 and " " in s:
            s = s.split(" ", 1)[1]
        sentence.setdefault((kind, v), s)
    out = {}
    for kind, c in found.items():
        if c:
            v, _ = c.most_common(1)[0]
            out[kind] = (v, sentence[(kind, v)])
    return out


# ── the share count the document states ──────────────────────────────────────

_SHARES = re.compile(r"(\d{1,3}(?:,\d{3}){1,3})\s+(?:shares\s+of\s+|)(?:the\s+)?(?:Company\s+|Company’s\s+|Company's\s+)?(?:Class\s+A\s+)?(?:[Cc]ommon\s+[Ss]tock|[Cc]ommon\s+[Ss]hares|[Oo]rdinary\s+[Ss]hares|[Cc]ommon\s+[Uu]nits|[Ss]hares)[^.;]{0,80}?(?:issued\s+and\s+)?outstanding", re.I)


def parse_shares(text: str) -> tuple[float | None, str | None]:
    """Shares outstanding as the transaction statement states them (Item 1(b)), in millions, with the phrase; the largest figure stated more than once, else the first."""
    found: Counter = Counter()
    phrase: dict[float, str] = {}
    for m in _SHARES.finditer(text):
        v = float(m.group(1).replace(",", "")) / 1e6
        if v < 0.1:
            continue
        found[v] += 1
        phrase.setdefault(v, re.sub(r"\s+", " ", m.group(0)).strip())
    if not found:
        return None, None
    top = found.most_common(1)[0][1]
    v = max(k for k, c in found.items() if c == top)
    return v, phrase[v]


# ── company names ────────────────────────────────────────────────────────────

#: a corporate suffix anywhere in the name marks a firm rather than a person
_INDIVIDUAL = re.compile(r"\b(LLC|L\.?L\.?C\.?|L\.?P\.?|LP|INC\.?|CORP\.?|CORPORATION|LTD\.?|LIMITED|PLC|HOLDINGS?|PARTNERS|FUND|CAPITAL|GROUP|COMPANY|CO\.?|S\.?A\.?|N\.?V\.?|A\.?G\.?|GMBH|TRUST|MANAGEMENT|INVESTORS|INVESTMENTS?|ACQUISITIONS?|PARTNERSHIP|VENTURES|ASSOCIATES|ADVISORS|ADVISERS|SARL|S\.?R\.?L\.?|B\.?V\.?|KK|K\.K\.|PTE|BHD|OY|AB|AS|ASA|SE|GP|LLP|FOUNDATION|BANK|SPV)\b", re.I)
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
        for p in parties:
            if not named_party(p) or same_company(p, target_name):
                continue
            sentence = re.sub(r"\s+", " ", _cut_sentence(m.group(0))).strip()
            return p.strip(" ,;:"), sentence[:400]
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


def reject_reason(name: str, sic: str | None, sic_description: str | None) -> str | None:
    """Why a filer is not a precedent target, once EDGAR's industry code is known; None when it is one."""
    sic = str(sic or "")
    desc = (sic_description or "").upper()
    if sic == "6770" and (shellish(name) or "BLANK CHECK" in desc):
        return "blank-check shell"
    if sic == "6726":
        return "closed-end fund or trust"
    return None
