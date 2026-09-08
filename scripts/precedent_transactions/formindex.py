"""
The deals the deck index cannot see: public mergers, and take-privates before 2020.

data/decks.auto.json only reaches back to 2020, and a Schedule 13E-3 is only
filed when an affiliate sits on the buy side, so a database built from it alone
skews recent, small and often distressed. It leaves out the strategic deals a
sector banker actually cites, and it leaves out every take-private filed before
2020.

Both gaps are filled from EDGAR's own quarterly form index, which lists every
filing of every form. Three of them are read here: the definitive merger proxy
(DEFM14A, or DEFM14C where the vote is taken by written consent) for
public-target mergers, and the going-private statement (SC 13E3) for the older
take-privates.

  the index      each quarter is about 57 MB, so it is streamed and filtered
                 line by line, and only the rows of those three forms are kept,
                 cached to data/merger-index.auto.json. A closed quarter is
                 read once and never downloaded again, and `forms` narrows
                 which of the cached types a pass reads.
  the subject    a 13E-3 is filed jointly, so the index prints a line per filer
                 and one statement arrives as several rows with different CIKs:
                 the company being bought, the vehicle buying it, the sponsor,
                 sometimes a named person. The rows are grouped by accession
                 and the filing's own index page says which filer is the
                 subject company, because only that one has the XBRL facts the
                 row needs. Where the page names no subject the filers are
                 tried in order and the first that files its own periodic
                 reports is taken. subjectBasis says which of those it was.
  the rejects    a de-SPAC vote is not a precedent transaction and there are
                 hundreds of them, so blank-check shells go by name before a
                 request is spent and by SIC once the filer is known; so do
                 closed-end fund reorganisations, and any filer already in the
                 database from its own 13E-3 for the same deal.
  the read       the same reading in every case (filings.read_documents), over
                 a different document list. A DEFM14A is the proxy, not a
                 wrapper around one, so its list is its own primary document; a
                 13E-3 gets the statement, its (a) exhibits and the target's
                 own proxy, which is the list a deck-index take-private gets.
                 Those run to tens of megabytes, hence the raised fetch cap.
  acquirer       there is no buyer group to rank in either case, so it is
                 parsed from the merger agreement sentence ("by and among Acme
                 Corporation, Bolt Merger Sub, Inc. and Target Inc."): the
                 first named party that is neither the target nor a merger
                 vehicle. acquirerBasis is the sentence it was read from, and
                 both are null where no party is named rather than guessed at.
  consideration  a public merger is frequently cash and stock, or all stock.
                 Stock in the consideration means a per-share cash figure is
                 not the price, so finalize flags the row and the multiples are
                 not to be used. The premium the filing states is still good,
                 and is kept.

buyers, advisers and the fee-table dealValue come from the deck index and no
filing here carries them, so rows read from the form index leave them out
rather than inventing them.

A proxy in which the filer's own holders vote on issuing shares rather than on
being acquired yields no per-share figure for the filer, correctly: it is an
acquirer-side vote, and it is recorded as status "no-consideration" so the
counts say how many of these the run met.
"""

from __future__ import annotations

import html
import json
import re
import sys
import time
import urllib.request
from datetime import date, datetime, timezone

from . import database, filings, parse

INDEX = database.DATA / "merger-index.auto.json"
FULL_INDEX = "https://www.sec.gov/Archives/edgar/full-index"

#: the definitive merger proxies (a vote at a meeting, and by written consent)
#: and the going-private statement. The transaction statement is how a
#: take-private before 2020 is found at all: the deck index that supplies the
#: newer ones only reaches back that far.
FORMS = ("DEFM14A", "DEFM14C", "SC 13E3")

#: form.idx is fixed width, and the form type occupies the first field. A form
#: type with a space in it ("SC 13E3") cannot be read by splitting on spaces.
FORM_COLS = 17

#: a merger proxy is the whole document, not a wrapper: tens of megabytes
DOC_CAP = 48_000_000

#: 13E-3 and DEFM14A are filed weeks apart for the same deal
DUP_DAYS = 180

#: the forms a company files about itself. A buyout vehicle files none of them
#: and neither does a person, so filing them is what marks the company whose
#: financials the row needs.
_REPORTS = {"10-K", "10-K405", "10-KSB", "10-KT", "10-Q", "10-QSB", "20-F", "40-F"}

#: how many filers are worth a submissions request before the first is taken
_TRIES = 5


# ── the quarterly form index ─────────────────────────────────────────────────


def quarters(since: int, through: date | None = None) -> list[str]:
    """Every quarter from the first of `since` to the one `through` falls in, as '2024Q1'."""
    end = through or date.today()
    out = []
    for y in range(since, end.year + 1):
        for q in range(1, 5):
            if y == end.year and q > (end.month - 1) // 3 + 1:
                break
            out.append(f"{y}Q{q}")
    return out


def _form_of(line: str) -> str:
    return line[:FORM_COLS].strip() if line else ""


def parse_index_line(line: str) -> dict | None:
    """
    One fixed-width form.idx row to a candidate. The company name carries
    spaces and the file name does not, so the line is split from the right:
    file name, date, CIK, and everything before them is form plus name.
    """
    form = _form_of(line)
    parts = line[FORM_COLS:].rstrip().rsplit(None, 3)
    if not form or len(parts) != 4:
        return None
    name, cik, filed, file_name = parts
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", filed) or not cik.isdigit():
        return None
    accession = file_name.rsplit("/", 1)[-1].removesuffix(".txt")
    if not re.fullmatch(r"\d{10}-\d{2}-\d{6}", accession):
        return None
    return {"form": form, "name": name.strip(), "cik": cik.zfill(10), "filed": filed, "accession": accession, "file": file_name}


def read_quarter(quarter: str, tries: int = 4) -> list[dict]:
    """
    The FORMS rows of one quarterly form index, streamed.

    The file is about 57 MB and a single response is capped well below that, so
    it is read here in chunks and split on newlines, never held whole. A
    transfer that long gets cut off now and then, and a truncated quarter would
    silently lose deals, so a failed read starts the quarter again rather than
    keeping what it got. The index is ordered by form type, so once the read is
    past the last of FORMS there is nothing left to find; the ordering is
    checked as it goes and the shortcut is dropped if the file ever comes back
    unsorted.
    """
    year, q = quarter.split("Q")
    url = f"{FULL_INDEX}/{year}/QTR{q}/form.idx"
    last: Exception | None = None
    for attempt in range(tries):
        # The same polite gap every other request keeps, before a download that
        # holds the connection open for a while.
        time.sleep(0.15 + 2.0 * attempt)
        req = urllib.request.Request(url, headers={"User-Agent": filings.UA, "Accept": "text/plain"})
        out: list[dict] = []
        prev, ordered, seen = "", True, False
        buf = b""
        try:
            with urllib.request.urlopen(req, timeout=300) as res:
                while True:
                    chunk = res.read(1 << 20)
                    if not chunk:
                        break
                    buf += chunk
                    lines = buf.split(b"\n")
                    buf = lines.pop()
                    stop = False
                    for raw in lines:
                        line = raw.decode("utf-8", "ignore")
                        form = _form_of(line)
                        if not form or form.startswith("-"):
                            continue
                        if form < prev:
                            ordered = False
                        prev = form
                        if form in FORMS:
                            seen = True
                            row = parse_index_line(line)
                            if row:
                                out.append(row)
                        elif ordered and seen and form > max(FORMS):
                            stop = True
                            break
                    if stop:
                        break
        except Exception as e:  # noqa: BLE001
            last = e
            print(f"  {quarter}: {type(e).__name__}, reading it again", file=sys.stderr, flush=True)
            continue
        return out
    raise RuntimeError(f"{quarter} form index could not be read: {last}")


def index(since: int = 2020, refresh: bool = False) -> list[dict]:
    """
    Every filing of a form in FORMS since `since`, from the cache where a
    quarter is already there and closed, from EDGAR otherwise. The quarter
    now running is always re-read, because it grows every day.
    """
    cache: dict = {}
    if INDEX.exists():
        try:
            cache = json.loads(INDEX.read_text()).get("quarters") or {}
        except Exception:  # noqa: BLE001
            cache = {}
    today = date.today()
    current = f"{today.year}Q{(today.month - 1) // 3 + 1}"
    rows: list[dict] = []
    changed = False
    for quarter in quarters(since, today):
        if quarter in cache and quarter != current and not refresh:
            rows.extend(cache[quarter])
            continue
        print(f"reading the {quarter} form index ...", file=sys.stderr, flush=True)
        got = read_quarter(quarter)
        cache[quarter] = got
        changed = True
        rows.extend(got)
        print(f"  {quarter}: {len(got)} filings", file=sys.stderr, flush=True)
    if changed:
        INDEX.parent.mkdir(parents=True, exist_ok=True)
        generated = datetime.now(timezone.utc).replace(microsecond=0, tzinfo=None).isoformat() + "Z"
        INDEX.write_text(json.dumps({"generatedAt": generated, "source": f"{FULL_INDEX}/<year>/QTR<n>/form.idx, {' and '.join(FORMS)} rows only", "quarters": dict(sorted(cache.items()))}, indent=1) + "\n")
    rows.sort(key=lambda r: (r["filed"], r["accession"]))
    return rows


# ── what has already been counted ────────────────────────────────────────────


def duplicate_of(cand: dict, take_privates: dict[str, list[tuple[str, str]]]) -> str | None:
    """
    The 13E-3 row for the same deal, when there is one. A take-private files
    both the transaction statement and the merger proxy, weeks apart, so the
    same deal would otherwise be counted twice. The same filer plus an
    announcement within six months is close enough: no company does two of
    these at once.
    """
    for announced, deal_id in take_privates.get(cand["cik"], []):
        try:
            gap = abs((date.fromisoformat(cand["filed"]) - date.fromisoformat(announced[:10])).days)
        except ValueError:
            continue
        if gap <= DUP_DAYS:
            return deal_id
    return None


def take_private_deals(stored: dict[str, dict]) -> dict[str, list[tuple[str, str]]]:
    """CIK to the (announcement date, accession) of each 13E-3 row it filed, for the duplicate check."""
    out: dict[str, list[tuple[str, str]]] = {}
    for row in stored.values():
        if (row.get("source") or "SC 13E3") != "SC 13E3":
            continue
        cik = str((row.get("target") or {}).get("cik") or "").zfill(10)
        if not cik.strip("0"):
            continue
        out.setdefault(cik, []).append((row.get("announced") or row.get("filed") or "", row.get("id") or ""))
    return out


# ── the subject company of a going-private statement ─────────────────────────

#: one filer of a filing index page. EDGAR gives each its own companyInfo
#: block, with the role in brackets after the name and the CIK in the link.
_PARTY_BLOCK = re.compile(r'<div class="companyInfo">(.*?)</div>', re.S | re.I)
_PARTY_HEAD = re.compile(r'<span class="companyName">\s*(.*?)\s*<acronym', re.S | re.I)
#: the name is everything before the role, and a name can carry brackets of
#: its own ("Acme (Jersey) Ltd"), so the role is the last bracketed piece
_PARTY_ROLE = re.compile(r"^(.*)\(([^()]{1,40})\)\s*$", re.S)


def group_13e3(cands: list[dict]) -> list[dict]:
    """
    One candidate per Schedule 13E-3, carrying every CIK the form index printed
    for it.

    A 13E-3 is filed jointly and the index prints a line per filer, so one
    statement arrives as several rows: the subject company, the buyout vehicle,
    the sponsor, sometimes a named individual. Left as they are they would read
    one filing several times over and store the row under whichever filer came
    last. The merger proxies pass through untouched, each being one filer's own
    filing.
    """
    out: list[dict] = []
    seen: dict[str, dict] = {}
    for c in cands:
        if c["form"] != "SC 13E3":
            out.append(c)
            continue
        g = seen.get(c["accession"])
        if g is None:
            g = {**c, "ciks": [], "names": []}
            seen[c["accession"]] = g
            out.append(g)
        if c["cik"] not in g["ciks"]:
            g["ciks"].append(c["cik"])
            g["names"].append(c["name"])
        g["filed"] = min(g["filed"], c["filed"])
    return out


def filing_parties(url: str) -> list[dict]:
    """
    The filers of one filing with the role EDGAR gives each ("Subject",
    "Filer", "Filed by"), read from its index page. Returns [] where the page
    cannot be read or names nobody, which the caller falls back from.

    A company that both filed the statement and is its subject gets a block per
    role, so the blocks are collapsed by CIK and the subject role wins: the
    question the caller asks is which company is being bought, and a filer that
    is named the subject anywhere on the page is that company.
    """
    try:
        raw = filings.fetch(url).decode("utf-8", "ignore")
    except Exception:  # noqa: BLE001
        return []
    out: list[dict] = []
    by_cik: dict[str, dict] = {}
    for block in _PARTY_BLOCK.findall(raw):
        head = _PARTY_HEAD.search(block)
        cik = re.search(r"CIK=(\d{10})", block)
        if not head or not cik:
            continue
        text = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", head.group(1)))).strip()
        m = _PARTY_ROLE.match(text)
        name, role = (m.group(1).strip(), m.group(2).strip()) if m else (text, "")
        if not name:
            continue
        sic = re.search(r"SIC=(\d{3,4})", block)
        p = by_cik.get(cik.group(1))
        if p is None:
            p = {"name": name, "role": role, "cik": cik.group(1), "sic": sic.group(1) if sic else None}
            by_cik[p["cik"]] = p
            out.append(p)
        elif "subject" in role.lower():
            p["role"] = role
    return out


def party_rank(party: dict) -> int:
    """
    How likely a filer is the company being bought, from its name alone: an
    operating company first, a buyout vehicle after it, a named individual
    last. The patterns are the ones the 13E-3 filer list is already ranked by,
    so a vehicle reads the same here as it does there.
    """
    name = party.get("name") or ""
    # No corporate suffix anywhere in the name: a person, and a person has no
    # financials at all.
    if not parse.is_firm(name):
        return 3
    if parse.is_vehicle(name) or parse.shellish(name) or parse.shell_name(name) or str(party.get("sic") or "") == "6770":
        return 2
    return 1


def files_reports(sub: dict) -> bool:
    """Whether a filer files periodic reports about itself, which is what a subject company does and a vehicle does not."""
    forms = ((sub.get("filings") or {}).get("recent") or {}).get("form") or []
    return any(str(f).split("/")[0] in _REPORTS for f in forms)


def resolve_subject(cand: dict, parties: list[dict]) -> tuple[dict, dict, str]:
    """
    Which joint filer of a 13E-3 is the company being taken private, its
    submissions record, and a sentence saying how that was decided.

    EDGAR labels one filer the subject company on the filing index, and where
    it does that is the answer: only the subject has the XBRL company facts the
    row needs, and reading a vehicle's CIK gives a row with no financials or
    with the buyer's. Where the page names no subject, or names more than one,
    the filers are tried in turn (an operating company before a vehicle, a
    vehicle before a person) and the first that files its own periodic reports
    is taken. Where none of them does, the best-ranked name stands and the row
    says so, which is honest about a filing whose subject could not be settled.
    """
    listed = parties or [{"name": n, "role": "", "cik": c, "sic": None} for c, n in zip(cand.get("ciks") or [cand["cik"]], cand.get("names") or [cand["name"]])]
    where = "the filing index" if parties else "the form index"
    subjects = [p for p in listed if "subject" in (p.get("role") or "").lower()]
    pool = sorted(subjects or listed, key=lambda p: (party_rank(p), listed.index(p)))
    subs: dict[str, dict] = {}

    def submissions(cik: str) -> dict:
        if cik not in subs:
            try:
                subs[cik] = filings.submissions(cik)
            except Exception:  # noqa: BLE001
                subs[cik] = {}
        return subs[cik]

    if len(subjects) == 1:
        p = pool[0]
        return p, submissions(p["cik"]), f"{where} names {parse.pretty(p['name'])} the subject company"
    for p in pool[:_TRIES]:
        sub = submissions(p["cik"])
        if sub and files_reports(sub):
            if subjects:
                return p, sub, f"{where} names {len(subjects)} subject companies and {parse.pretty(p['name'])} is the one that files its own periodic reports"
            return p, sub, f"{where} names no subject company; {parse.pretty(p['name'])} is the first of its {len(listed)} filers that files its own periodic reports"
    p = pool[0]
    return p, submissions(p["cik"]), f"{where} names no subject company and none of its {len(listed)} filers file periodic reports; {parse.pretty(p['name'])} is the first that is neither a merger vehicle nor a person"


# ── one deal ─────────────────────────────────────────────────────────────────


def _primary_doc(cand: dict, sub: dict) -> dict | None:
    """
    The proxy itself. The submissions file names the primary document of each
    filing, which is the whole proxy; where the filing is too old to be in the
    recent list, the index page's largest document is the same thing.
    """
    accn = cand["accession"]
    base = f"{filings.ARCHIVES}/data/{int(cand['cik'])}/{accn.replace('-', '')}"
    r = (sub.get("filings") or {}).get("recent") or {}
    for a, d in zip(r.get("accessionNumber", []), r.get("primaryDocument", [])):
        if a == accn and d:
            return {"name": d, "type": cand["form"], "size": 0, "url": f"{base}/{d}", "role": "proxy"}
    docs = [d for d in filings.index_page(f"{base}/{accn}-index.htm") if d["name"].lower().endswith((".htm", ".html", ".txt"))]
    if not docs:
        return None
    d = max(docs, key=lambda d: d["size"])
    return {**d, "role": "proxy"}


def build_proxy_row(cand: dict) -> dict:
    """
    One precedent row from one merger proxy: the same reading a 13E-3 row
    gets, over the proxy itself, plus the acquirer parsed from the merger
    agreement sentence. `finalize` derives the values.
    """
    sub = filings.submissions(cand["cik"])
    sic = str(sub.get("sic") or "") or None
    sic_description = sub.get("sicDescription") or None
    name = (sub.get("name") or cand["name"] or "").strip()
    row: dict = {
        "id": cand["accession"],
        "source": cand["form"],
        "dealType": "public merger",
        "target": {"name": name, "cik": cand["cik"], "sic": sic, "sicDescription": sic_description, "state": sub.get("stateOfIncorporation")},
        "sector": database.sector_for_sic(sic),
        "buyers": [],
        "buyerType": "Unclassified",
        "advisers": [],
        "dealValue": None,
        "filed": cand["filed"],
        "filingUrl": f"{filings.ARCHIVES}/data/{int(cand['cik'])}/{cand['accession'].replace('-', '')}/{cand['accession']}-index.htm",
        "announced": cand["filed"],
        "announcedBasis": "filing date",
        "offerPrice": None,
        "offerBasis": None,
        "consideration": "cash",
        "acquirer": None,
        "acquirerBasis": None,
        "premium1Day": None,
        "premium30DayVwap": None,
        "premium52WeekHigh": None,
        "premiumBasis": [],
        "documentsRead": [],
        "readErrors": [],
        "status": "ok",
    }
    reason = parse.reject_reason(name, sic, sic_description)
    if reason:
        row["status"], row["error"] = "rejected", reason
        return row
    doc = _primary_doc(cand, sub)
    if not doc:
        row["status"], row["error"] = "error", "no document on the filing index"
        return row
    row["primaryDocUrl"] = doc["url"]
    seen: dict = {}

    def on_text(r: dict, text: str) -> None:
        """The two fields a proxy carries that a 13E-3 filer list does not."""
        if not r.get("acquirer"):
            acq, basis = parse.parse_acquirer(text, r["target"]["name"])
            if acq:
                r["acquirer"], r["acquirerBasis"] = acq, basis
        seen["stock"] = seen.get("stock") or parse.mixed_consideration(text)
        seen["acquirerSide"] = seen.get("acquirerSide") or parse.acquirer_side(text)

    row = filings.read_documents(row, [doc], cap=DOC_CAP, on_text=on_text)
    # All stock is still a merger and still gives a premium; it gives no cash
    # price, so the row says so and finalize keeps it out of the multiples.
    if seen.get("stock") and row.get("offerPrice") is None:
        row["consideration"] = "stock"
    if seen.get("acquirerSide"):
        row["offerPrice"], row["offerBasis"] = None, None
        row["status"] = "no-consideration"
        row["error"] = "the filer's own holders voted on issuing shares, not on being acquired"
    elif row.get("acquirer") and parse.shell_name(row["acquirer"]):
        # A de-SPAC read from the operating company's side: the shell is the
        # counterparty rather than the filer, and $10.00 a trust unit is not
        # an offer price.
        row["status"] = "rejected"
        row["error"] = "de-SPAC: the counterparty is a blank-check shell"
    return row


def _buyer_type(acquirer: str | None) -> str | None:
    """
    The buyer type for a row that has no buyer group to read it from. The pages
    print it where they have no acquirer name, so a bucket that says nothing
    ("Unclassified") is worse than none at all and is dropped.
    """
    kind = parse.classify_buyer(acquirer) if acquirer else "Unclassified"
    return None if kind == "Unclassified" else kind


def build_13e3_row(cand: dict) -> dict:
    """
    One take-private row from one Schedule 13E-3: the row the deck index would
    have given us had it reached this far back.

    The reading is the one a deck-index take-private gets, over the same
    document list (the statement, its (a) exhibits and the target's own proxy),
    against the filer resolved as the subject company. The buyers, the advisers
    and the fee-table value are the deck index's own and no filing carries
    them, so they are left out; the acquirer is read from the merger agreement
    sentence the way a merger proxy's is.
    """
    accn = cand["accession"]
    folder = accn.replace("-", "")
    ciks = cand.get("ciks") or [cand["cik"]]

    def index_url(cik: str) -> str:
        return f"{filings.ARCHIVES}/data/{int(cik)}/{folder}/{accn}-index.htm"

    # EDGAR serves the filing from every filer's own path, so the roles can be
    # read before there is any view on which filer the row belongs to.
    parties = filing_parties(index_url(ciks[0]))
    party, sub, basis = resolve_subject(cand, parties)
    cik = party["cik"]
    sic = str(sub.get("sic") or party.get("sic") or "") or None
    sic_description = sub.get("sicDescription") or None
    name = (sub.get("name") or party["name"] or "").strip()
    row: dict = {
        "id": accn,
        "source": "SC 13E3",
        "dealType": "take-private",
        "target": {"name": name, "cik": cik, "sic": sic, "sicDescription": sic_description, "state": sub.get("stateOfIncorporation")},
        "sector": database.sector_for_sic(sic),
        "subjectBasis": basis,
        "filers": [{"name": p["name"], "cik": p["cik"], "role": p["role"]} for p in parties],
        "buyerType": None,
        "filed": cand["filed"],
        "filingUrl": index_url(cik),
        "announced": cand["filed"],
        "announcedBasis": "filing date",
        "offerPrice": None,
        "offerBasis": None,
        "consideration": "cash",
        "acquirer": None,
        "acquirerBasis": None,
        "premium1Day": None,
        "premium30DayVwap": None,
        "premium52WeekHigh": None,
        "premiumBasis": [],
        "documentsRead": [],
        "readErrors": [],
        "status": "ok",
    }
    reason = parse.reject_reason(name, sic, sic_description)
    if reason:
        row["status"], row["error"] = "rejected", reason
        return row
    # docs_for wants a deck-index entry; a candidate off the form index has
    # only the accession, the date and the CIK just resolved, which is all of
    # that entry the document list is built from.
    tx = {"id": accn, "target": {"cik": cik}, "filings": [{"filed": cand["filed"], "filingUrl": row["filingUrl"]}]}
    docs = filings.docs_for(tx, sub)
    if not docs:
        row["status"], row["error"] = "error", "no document on the filing index"
        return row
    row["primaryDocUrl"] = docs[0]["url"]
    seen: dict = {}

    def on_text(r: dict, text: str) -> None:
        """The acquirer, which a 13E-3 read this way has no filer list to give."""
        if not r.get("acquirer"):
            acq, sentence = parse.parse_acquirer(text, r["target"]["name"])
            if acq:
                r["acquirer"], r["acquirerBasis"] = acq, sentence
        seen["stock"] = seen.get("stock") or parse.mixed_consideration(text)

    row = filings.read_documents(row, docs, cap=DOC_CAP, on_text=on_text)
    # An affiliate merger paid in stock is rare but real, and its cash figure
    # is not the price; the premium the filing states still is.
    if seen.get("stock") and row.get("offerPrice") is None:
        row["consideration"] = "stock"
    row["buyerType"] = _buyer_type(row.get("acquirer"))
    return row


def build_row(cand: dict) -> dict:
    """One precedent row from one indexed filing, read as what it is: a merger proxy, or a going-private statement."""
    return build_13e3_row(cand) if cand["form"] == "SC 13E3" else build_proxy_row(cand)


# ── the builder ──────────────────────────────────────────────────────────────


def build(limit: int | None = None, since: int = 2020, only: str | None = None, full: bool = False, forms: tuple[str, ...] = FORMS) -> dict:
    """
    Read the index, add or refresh rows, write the shared database and return it.

    `forms` narrows which of the indexed form types are read this pass. The
    index itself is always built for every form in FORMS and cached per
    quarter, so reading one type now and another later costs no second
    download of a 57 MB quarter.
    """
    stored = database.load_stored()
    # A row already on file is never read again, whichever builder wrote it:
    # the deck-index take-privates are keyed by the same 13E-3 accessions this
    # pass would read, and that is what keeps a deal out of the database twice.
    known = {k for k, v in stored.items() if (v.get("source") or "SC 13E3") in forms}
    # --full drops this pass's own rows and reads them again. The take-privates
    # takeprivates.py read from the deck index share their source with ours and
    # are not this builder's to throw away, so they are told apart by the
    # subject resolution only a form-index row carries.
    owned = {k: v for k, v in stored.items() if k in known and (v.get("source") != "SC 13E3" or "subjectBasis" in v)}
    existing: set[str] = set() if full else known
    # --full with --only means "read that one again", not "start the universe
    # over", so the other rows stay where they are.
    rows = {k: v for k, v in stored.items() if k not in owned} if (full and not only) else dict(stored)
    take_privates = take_private_deals(stored)

    cands = group_13e3([c for c in index(since=since) if c["form"] in forms])
    todo, spacs, dups = [], 0, 0
    for c in cands:
        if only:
            if c["accession"] == only:
                todo.append(c)
            continue
        if c["accession"] in existing:
            continue
        # On a 13E-3 the shell is a filer beside the company being bought, so
        # only a filing with nothing else on it is a shell's own.
        if all(parse.shell_name(n) for n in (c.get("names") or [c["name"]])):
            spacs += 1
            continue
        if any(duplicate_of({**c, "cik": cik}, take_privates) for cik in (c.get("ciks") or [c["cik"]])):
            dups += 1
            continue
        todo.append(c)
    if only and not todo:
        raise SystemExit(f"{only} is not in the merger index.")
    if limit:
        todo = todo[:limit]
    print(f"{len(cands)} {' and '.join(forms)} filings since {since}, {len(known)} already in the database, {spacs} blank-check shells and {dups} deals already read from another filing skipped, {len(todo)} to read", file=sys.stderr)

    read = 0
    for i, c in enumerate(todo, 1):
        try:
            row = database.finalize(build_row(c))
        except KeyboardInterrupt:
            raise
        except Exception as e:  # noqa: BLE001
            row = {"id": c["accession"], "source": c["form"], "dealType": "take-private" if c["form"] == "SC 13E3" else "public merger", "target": {"name": c["name"], "cik": c["cik"], "sic": None, "sicDescription": None, "state": None}, "sector": None, "announced": c["filed"], "announcedBasis": "filing date", "filed": c["filed"], "filingUrl": f"{filings.ARCHIVES}/data/{int(c['cik'])}/{c['accession'].replace('-', '')}/{c['accession']}-index.htm", "status": "error", "error": f"{type(e).__name__}: {str(e)[:120]}", "flags": []}
        rows[row["id"]] = row
        read += 1
        print(f"[{i}/{len(todo)}] {database.line(row)}", file=sys.stderr, flush=True)
        # Write as it goes, so a run cut short keeps what it read.
        if i % 10 == 0:
            database.write(rows)
    out = database.write(rows)
    c = out["counts"]
    print(f"\n{read} filings read. {c['transactions']} transactions on file: {c['publicMergers']} public mergers, {c['takePrivates']} take-privates, {c['withOffer']} with an offer price, {c['withMultiples']} with EV / LTM EBITDA, {c['withPremium']} with a stated premium, {c['flagged']} flagged for checking, {c['noOffer']} with no offer found, {c['noConsideration']} acquirer-side votes, {c['rejected']} rejected, {c['errors']} errors.", file=sys.stderr)
    return out
