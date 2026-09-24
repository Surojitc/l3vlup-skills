#!/usr/bin/env python3
"""
Who is in an industry, so a peer screen does not have to ask EDGAR every time.

The comps lab builds its universe the way a banker defends one: everybody the
SEC files under the same Standard Industrial Classification code. Answering
that from EDGAR live costs three paginated company-search calls and a download
of the SEC's ten-thousand-row ticker file before a single price is fetched, and
it answers a question that barely moves between one month and the next. Prices
move by the second and stay live. Membership does not, so it is collected here.

The file this writes, data/peers.auto.json, holds per industry:

  filers    every company EDGAR lists under the code with a 10-K on file, which
            is the number the lab prints when it shows how a universe narrowed
  listed    the subset carrying a ticker, which is all a screen can price

Sources, both public and keyless:

  browse-edgar company search   the members of a SIC code, a hundred per page
  company_tickers.json          the SEC's own CIK to ticker mapping
  corpfin SIC code list         the 444 codes EDGAR actually assigns, with the
                                official industry title for each

A rolling refresh, inside a time budget. The company search is EDGAR's legacy
CGI endpoint and costs six to eight seconds a page whatever the pace, so the
whole catalogue is about 880 pages and an hour and three quarters: longer than
the step that runs it is allowed. So what each industry's crawl found is kept
in data/peers-crawl.auto.json, committed beside the output, and a run re-reads
the industries it has never seen and then the ones it read longest ago, until
--budget-minutes is spent. Everything it did not reach this time comes from
that file. The output is therefore written on every run, complete, and each
industry is at most a couple of monthly cycles old; the ticker join is redone
from a fresh ticker file every time, so a company that listed since its
industry was last crawled still gains its ticker.

--max-age-days is when an industry becomes due again. --full treats every
industry as due. --sic crawls one code. One industry's failure never stops the
run, and never drops that industry from the file while an older crawl of it
exists.

    python3 scripts/sync_peers.py
    python3 scripts/sync_peers.py --budget-minutes 60
    python3 scripts/sync_peers.py --sic 3841 --full
    python3 scripts/sync_peers.py --out ../L3vlup/data/peers.auto.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "peers.auto.json"
#: What each industry's crawl found, so the next run need not read it again.
#: Committed rather than kept under .cache, because a runner starts empty and
#: a cache that does not survive the run is a cold crawl every month.
CRAWL = ROOT / "data" / "peers-crawl.auto.json"
PRECEDENTS = ROOT / "data" / "precedent-transactions.auto.json"

#: A contact in the user agent is what EDGAR asks for in return for no API key.
UA = os.environ.get("SEC_USER_AGENT", "L3VLUP open skills contact@l3vlup.com")

BROWSE = "https://www.sec.gov/cgi-bin/browse-edgar"
TICKERS = "https://www.sec.gov/files/company_tickers.json"
SIC_LIST = (
    "https://www.sec.gov/corpfin/"
    "division-of-corporation-finance-standard-industrial-classification-sic-code-list"
)

#: Members per company-search page. EDGAR's own maximum.
PAGE = 100

#: Pages read per industry before the crawl gives up on it. Sixty pages is six
#: thousand filers, which clears the largest code EDGAR has (6770, blank
#: cheques, at about 3,300) with room to spare. A code that hits this is
#: reported rather than silently truncated.
MAX_PAGES = 60

#: The gap between requests. EDGAR asks for ten a second at most; this is well
#: inside that and leaves room for the retries below.
GAP = 0.15


# ── HTTP ─────────────────────────────────────────────────────────────────────

_last = 0.0
#: Requests EDGAR refused and we asked for again. Reported at the end, because
#: a run that retried half its requests is a run that was too fast.
_retried = 0


def get(url: str, *, accept: str = "application/json", retries: int = 4) -> bytes:
    """One polite request: a contact in the user agent, a gap, and a backoff."""
    global _last, _retried
    err = None
    for attempt in range(retries):
        wait = _last + GAP - time.time()
        if wait > 0:
            time.sleep(wait)
        _last = time.time()
        req = urllib.request.Request(
            url, headers={"User-Agent": UA, "Accept": accept, "Accept-Encoding": "identity"}
        )
        try:
            with urllib.request.urlopen(req, timeout=90) as res:
                return res.read()
        except urllib.error.HTTPError as e:
            err = e
            if e.code == 404:
                raise
            # 403 and 429 are EDGAR asking us to slow down. 503 is EDGAR busy.
            _retried += 1
            time.sleep(1.5 * (attempt + 1))
        except Exception as e:  # transient DNS, reset connection, read timeout
            err = e
            _retried += 1
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{url} failed after {retries} attempts: {err}")


def get_text(url: str, accept: str = "text/html") -> str:
    return get(url, accept=accept).decode("utf-8", "ignore")


# ── names ────────────────────────────────────────────────────────────────────

#: Words the SEC shouts that are not words. "nec" is "not elsewhere
#: classified" and belongs in capitals wherever it appears.
_ACRONYMS = {
    "Nec": "NEC", "Reit": "REIT", "Reits": "REITs", "Usa": "USA",
    "Tv": "TV", "Ii": "II", "Iii": "III", "Llc": "LLC", "Lp": "LP",
}
_LOWER = {"and", "or", "of", "the", "in", "for", "to", "de", "a", "an"}


def title_case(s: str) -> str:
    """
    SEC industry titles are shouted. This speaks them.

    Only ever applied to text that is entirely upper case, so a title the SEC
    has already cased properly is left exactly as filed.
    """
    t = s.replace("&amp;", "&").replace("&#39;", "\u2019").strip()
    if t != t.upper():
        return t

    def word(w: str, first: bool) -> str:
        if not w:
            return w
        if w.lower() in _LOWER and not first:
            return w.lower()
        # An internal ampersand marks initials rather than a word: AT&T, S&P.
        if "&" in w.strip("&"):
            return w.upper()
        # A token carrying a digit is a name, and its letter runs are cased
        # one by one so 3M stays 3M and L3HARRIS becomes L3Harris.
        if any(c.isdigit() for c in w):
            return re.sub(r"[A-Za-z]+", lambda mm: mm.group(0)[:1].upper() + mm.group(0)[1:].lower(), w)
        # Capitalise the first letter, which is not always the first character:
        # "(NO DEVELOPERS)" opens on a bracket.
        i = next((k for k, c in enumerate(w) if c.isalnum()), len(w))
        cased = w[:i] + w[i : i + 1].upper() + w[i + 1 :].lower()
        # Punctuation the token was carrying stays on it: "NEC." is "NEC.".
        bare = cased.strip(",.()'’")
        return cased.replace(bare, _ACRONYMS[bare], 1) if bare in _ACRONYMS else cased

    out = []
    for i, chunk in enumerate(t.split(" ")):
        if not chunk:
            continue
        # Hyphens and slashes join two words and both of them need casing:
        # "AGRICULTURAL PRODUCTION-CROPS" is not "Agricultural Production-crops".
        # Nothing after a joiner is ever a small word, so only the very first
        # token of the whole string counts as leading.
        parts = re.split(r"([-/])", chunk)
        out.append("".join(
            p if p in "-/" else word(p, i == 0 or j > 0)
            for j, p in enumerate(parts)
        ))
    return " ".join(out)


def pad(sic: str) -> str:
    """
    Four digits, always.

    The SEC writes the same code three ways: the corpfin list gives crop
    production as 100, a submissions record gives it as 0100, and EDGAR's
    company search accepts either. One spelling in the file means the site can
    look a code up without guessing which one it holds.
    """
    digits = re.sub(r"\D", "", sic or "")
    return digits.zfill(4) if digits else ""


# ── the codes worth crawling ─────────────────────────────────────────────────


def sic_catalogue() -> dict[str, str]:
    """
    Every SIC code EDGAR assigns, with the SEC's own title for it.

    This is the whole catalogue rather than a selection, because inverting it
    is what makes the cache complete: a reader can type any ticker, and the
    code behind that ticker has been crawled whether or not the site has ever
    seen the company before. Resolving the codes the other way round, by asking
    EDGAR for the industry of each of the ten thousand registrants in the
    ticker file, would cost seven times the requests and cover less.
    """
    html = get_text(SIC_LIST)
    out: dict[str, str] = {}
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S):
        cells = [
            re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", c)).strip()
            for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S)
        ]
        if len(cells) >= 3 and re.fullmatch(r"\d{2,4}", cells[0]):
            out[pad(cells[0])] = title_case(cells[2])
    if len(out) < 100:
        raise RuntimeError(f"the SIC code list read as only {len(out)} codes")
    return out


def precedent_sics() -> dict[str, str]:
    """
    The industry of every target in the precedent-transactions database.

    A deal the site already shows is proof that its industry matters to a
    reader here, and it is also the one place a code can turn up that the
    published catalogue does not carry, since the catalogue is a current list
    and a 2004 target may sit under a code since retired.
    """
    if not PRECEDENTS.exists():
        return {}
    try:
        rows = json.loads(PRECEDENTS.read_text()).get("transactions", [])
    except Exception as e:
        print(f"  precedent transactions unreadable ({type(e).__name__}), skipping that seed")
        return {}
    out: dict[str, str] = {}
    for r in rows:
        target = r.get("target") or {}
        code = pad(str(target.get("sic") or ""))
        if code:
            out.setdefault(code, title_case(str(target.get("sicDescription") or "")))
    return out


def ticker_index() -> dict[str, tuple[str, str]]:
    """
    CIK to ticker and registrant name, from the SEC's own mapping file.

    Share classes are listed separately and the first line is the primary one,
    which is the same rule lib/comps.ts applies when it reads this file live.
    """
    data = json.loads(get(TICKERS).decode("utf-8", "ignore"))
    out: dict[str, tuple[str, str]] = {}
    for row in data.values():
        cik = str(row.get("cik_str", "")).zfill(10)
        ticker = str(row.get("ticker", "")).upper().strip()
        if not ticker or cik in out:
            continue
        out[cik] = (ticker, title_case(str(row.get("title", "")).strip()))
    return out


# ── the crawl ────────────────────────────────────────────────────────────────

_CIK_RE = re.compile(r"<cik>(\d{10})</cik>")


class OutOfTime(Exception):
    """The budget ran out partway through an industry. Its older crawl stands."""


def filers_in(sic: str, deadline: float | None = None) -> tuple[list[str], int, bool]:
    """
    Every CIK EDGAR lists under one industry code, with a 10-K on file.

    The company search returns a hundred at a time in name order, so a single
    page is not an industry: for prepackaged software it is the companies
    beginning with A. Reading to the end is the whole point of collecting this
    ahead of time, since it is the part the site cannot afford to do live.

    Pages overlap slightly when a filer's name changes mid-crawl, so the list
    is deduplicated while keeping EDGAR's order. Returns the CIKs, the pages
    read, and whether the page cap cut the crawl short.

    The deadline is checked between pages rather than only between
    industries, because one industry can be sixty pages and seven minutes. An
    industry cut off halfway is abandoned rather than recorded, since half a
    list would read as an industry that had lost half its members.
    """
    seen: set[str] = set()
    order: list[str] = []
    pages = 0
    while pages < MAX_PAGES:
        if deadline is not None and time.time() > deadline:
            raise OutOfTime(sic)
        url = (
            f"{BROWSE}?action=getcompany&SIC={urllib.parse.quote(sic)}&type=10-K"
            f"&dateb=&owner=include&count={PAGE}&start={pages * PAGE}&output=atom"
        )
        xml = get(url, accept="application/atom+xml").decode("utf-8", "ignore")
        pages += 1
        found = _CIK_RE.findall(xml)
        for cik in found:
            if cik not in seen:
                seen.add(cik)
                order.append(cik)
        if len(found) < PAGE:
            return order, pages, False
    return order, pages, True


def load_crawl(path: Path | None = None) -> dict[str, dict]:
    """
    The last crawl of every industry, keyed by four-digit code.

    CIKs are stored as integers, which is how EDGAR thinks of them and about
    half the bytes of the zero-padded strings, and are padded back here. An
    unreadable file is a crawl we have not done, never a reason to stop.
    """
    path = path or CRAWL
    try:
        raw = json.loads(path.read_text())
    except FileNotFoundError:
        return {}
    except Exception as e:
        print(f"  {path.name} unreadable ({type(e).__name__}), starting from nothing")
        return {}
    out: dict[str, dict] = {}
    for sic, rec in (raw.get("industries") or {}).items():
        if not isinstance(rec, dict) or not isinstance(rec.get("ciks"), list):
            continue
        out[pad(sic)] = {
            "ciks": [str(c).zfill(10) for c in rec["ciks"]],
            "pages": int(rec.get("pages") or 0),
            "capped": bool(rec.get("capped")),
            "fetchedAt": str(rec.get("fetchedAt") or ""),
        }
        if rec.get("filers") is not None:
            out[pad(sic)]["filers"] = int(rec["filers"])
    return out


def crawl_payload(crawl: dict[str, dict]) -> dict:
    """The crawl file as written: sorted, integer CIKs, one line."""
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": "EDGAR company search by SIC, 10-K filers, every page",
        "industries": {
            sic: {
                "fetchedAt": rec["fetchedAt"],
                "pages": rec["pages"],
                "capped": rec["capped"],
                # Present only on a stand-in from the published file, whose
                # CIKs are the listed members rather than every filer.
                **({"filers": rec["filers"]} if "filers" in rec else {}),
                "ciks": [int(c) for c in rec["ciks"]],
            }
            for sic, rec in sorted(crawl.items())
        },
    }


def refresh_order(codes: list[str], crawl: dict[str, dict], *, max_age_days: float,
                  full: bool, now: datetime) -> list[str]:
    """
    Which industries to read again this run, most overdue first.

    Never crawled comes first, because an industry the file cannot answer for
    at all costs a reader more than one that is a month old. Then a stand-in
    from the published file, which is always due whatever its date, since it
    was never a crawl. Then the oldest crawl. An industry read inside
    --max-age-days is not due, unless --full.
    """
    cutoff = now - timedelta(days=max_age_days)

    def fetched(sic: str) -> datetime | None:
        try:
            return datetime.fromisoformat(crawl[sic]["fetchedAt"])
        except (KeyError, ValueError):
            return None

    def rank(sic: str) -> int:
        if fetched(sic) is None:
            return 0
        return 1 if "filers" in crawl[sic] else 2

    due = [c for c in codes if full or rank(c) < 2 or fetched(c) < cutoff]
    epoch = datetime.min.replace(tzinfo=timezone.utc)
    return sorted(due, key=lambda c: (rank(c), fetched(c) or epoch, c))


def write_atomic(path: Path, body: str) -> None:
    """Land under a temporary name and move into place, so a kill never leaves half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(body)
    os.replace(tmp, path)


# ── the run ──────────────────────────────────────────────────────────────────


def from_published(crawl: dict[str, dict]) -> int:
    """
    Fill the crawl record's gaps from the last published peer file.

    The published file keeps only the listed members of an industry and its
    filer count, not every CIK, so this is a stand-in rather than a crawl: it
    carries the file's own generatedAt as its fetchedAt, which makes it the
    most overdue thing on record and first in line to be read properly. What
    it buys is that a run which has lost the crawl record, or the first run
    after the record was introduced, still writes every industry instead of
    the fraction its budget reached, which the publication gate would refuse.
    """
    try:
        published = json.loads(OUT.read_text())
    except Exception:
        return 0
    stamp = str(published.get("generatedAt") or "")
    added = 0
    for sic, row in (published.get("industries") or {}).items():
        code = pad(sic)
        if code in crawl or not isinstance(row, dict):
            continue
        ciks = [str(r.get("cik", "")).zfill(10) for r in row.get("listed") or [] if r.get("cik")]
        crawl[code] = {
            "ciks": ciks,
            "pages": 0,
            "capped": False,
            "fetchedAt": stamp,
            "filers": int(row.get("filers") or len(ciks)),
        }
        added += 1
    return added


def previous_titles() -> dict[str, str]:
    """Industry titles from the last published file, for a morning the SEC's list is down."""
    try:
        rows = json.loads(OUT.read_text()).get("industries") or {}
        return {pad(k): str(v.get("description") or f"SIC {k}") for k, v in rows.items()}
    except Exception:
        return {}


def main() -> int:
    # A step's log is only useful while the step is running if each line
    # reaches it as it is printed. Piped, Python holds output back in blocks,
    # which is how an hour and a half of crawl arrived as three bursts and a
    # timeout with nothing to say where the time had gone.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)

    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--sic", action="append", help="crawl this code only (repeatable)")
    ap.add_argument("--limit", type=int, help="crawl at most this many industries")
    ap.add_argument("--full", action="store_true", help="treat every industry as due")
    ap.add_argument("--max-age-days", type=float, default=25,
                    help="re-crawl an industry once its last crawl is this old (default 25)")
    ap.add_argument("--budget-minutes", type=float, default=None,
                    help="stop crawling after this long and write what is known")
    ap.add_argument("--out", type=Path, action="append", default=None,
                    help="write the output here as well as data/peers.auto.json")
    args = ap.parse_args()

    started = time.time()
    deadline = started + args.budget_minutes * 60 if args.budget_minutes is not None else None
    now = datetime.now(timezone.utc)

    crawl = load_crawl()
    print(f"crawl file: {len(crawl)} industries on record")
    stood_in = from_published(crawl)
    if stood_in:
        print(f"  {stood_in} more stood in for from the last published file, due first")

    print("SIC code list")
    try:
        catalogue = sic_catalogue()
        print(f"  {len(catalogue)} codes published by the SEC")
    except Exception as e:
        # The list only names the codes; the crawl file already knows them.
        catalogue = {c: t for c, t in previous_titles().items() if c in crawl}
        if not catalogue:
            raise
        print(f"  unreadable ({type(e).__name__}: {e}); using the {len(catalogue)} codes already on record")

    seeded = precedent_sics()
    extra = {c: d for c, d in seeded.items() if c not in catalogue}
    print(f"  {len(seeded)} codes carry a precedent transaction, "
          f"{len(extra)} of them outside the published list")
    for code, description in extra.items():
        catalogue[code] = description or f"SIC {code}"

    print("SEC ticker file")
    tickers = ticker_index()
    print(f"  {len(tickers)} registrants with a ticker\n")

    # Every industry the file covers, whether or not it is crawled this run.
    codes = sorted(catalogue)
    if args.sic:
        # --sic narrows what is crawled, never what is written: a one-code
        # run that wrote a one-industry file would wipe out the other 443.
        want = {pad(s) for s in args.sic}
        for c in sorted(want - set(codes)):
            # A code nobody publishes can still be crawled: EDGAR answers for it
            # or it comes back empty, and either is an honest answer.
            catalogue.setdefault(c, f"SIC {c}")
        codes = sorted(set(codes) | want)
        todo = sorted(want)
    else:
        todo = refresh_order(codes, crawl, max_age_days=args.max_age_days, full=args.full, now=now)
    if args.limit:
        todo = todo[: args.limit]

    budget = f"{args.budget_minutes:g} min budget" if deadline is not None else "no time budget"
    print(f"{len(codes)} industries · {len(todo)} due for a crawl · {budget}\n")

    stats = {"crawled": 0, "capped": [], "failed": [], "unreached": []}
    for i, sic in enumerate(todo, 1):
        label = catalogue.get(sic) or f"SIC {sic}"
        if deadline is not None and time.time() > deadline:
            stats["unreached"] = todo[i - 1:]
            print(f"budget spent after {stats['crawled']} industries; "
                  f"{len(todo) - i + 1} left for the next run")
            break
        t0 = time.time()
        try:
            ciks, pages, capped = filers_in(sic, deadline)
        except OutOfTime:
            stats["unreached"] = todo[i - 1:]
            print(f"[{i:>3}/{len(todo)}] {sic} {label[:38]:<38} budget spent mid-industry; "
                  f"its last crawl stands")
            break
        except Exception as e:
            # One dead code is not a dead run, and not a missing industry
            # either while an older crawl of it is on record.
            held = " (last crawl kept)" if sic in crawl else ""
            print(f"[{i:>3}/{len(todo)}] {sic} {label[:38]:<38} {type(e).__name__}: {e}{held}")
            stats["failed"].append(f"{sic} {label}: {type(e).__name__}: {e}{held}")
            continue
        crawl[sic] = {
            "ciks": ciks, "pages": pages, "capped": capped,
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
        }
        stats["crawled"] += 1
        if capped:
            stats["capped"].append(sic)
        flag = "  CAPPED" if capped else ""
        print(f"[{i:>3}/{len(todo)}] {sic} {label[:38]:<38} {len(ciks):>5} filers · "
              f"{pages:>2} page{' ' if pages == 1 else 's'} · {time.time() - t0:5.0f}s{flag}")

    # The join, for every industry with a crawl on record, fresh or not.
    industries: dict[str, dict] = {}
    matched: set[str] = set()
    empty: list[str] = []
    for sic in codes:
        record = crawl.get(sic)
        if record is None:
            continue
        filers = record.get("filers", len(record["ciks"]))
        if not filers:
            empty.append(sic)
            continue
        listed = []
        for cik in record["ciks"]:
            hit = tickers.get(cik)
            if hit:
                listed.append({"cik": cik, "ticker": hit[0], "name": hit[1]})
                matched.add(cik)
        industries[sic] = {
            "description": catalogue.get(sic) or f"SIC {sic}",
            "filers": filers,
            "listed": listed,
        }

    if not industries:
        print("nothing crawled and nothing on record, refusing to write a file")
        return 1

    # Written before the output, so a crawl this run paid for is never lost to
    # whatever happens next.
    write_atomic(CRAWL, json.dumps(crawl_payload(crawl), separators=(",", ":")) + "\n")

    stamps = [crawl[s]["fetchedAt"] for s in industries if crawl[s].get("fetchedAt")]
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": "EDGAR company search by SIC, and the SEC ticker file",
        "counts": {
            "industries": len(industries),
            "companies": sum(v["filers"] for v in industries.values()),
            "listed": sum(len(v["listed"]) for v in industries.values()),
        },
        # Membership is a rolling crawl; the tickers are joined fresh each run.
        "oldestCrawl": min(stamps) if stamps else None,
        "industries": dict(sorted(industries.items())),
    }

    body = json.dumps(payload, separators=(",", ":")) + "\n"
    for target in [OUT] + list(args.out or []):
        write_atomic(target, body)
        print(f"\nwrote {target} ({len(body) / 1e6:.2f} MB)")

    c = payload["counts"]
    covered = len(matched) / len(tickers) * 100 if tickers else 0
    print(f"industries {c['industries']} · filers {c['companies']:,} · listed {c['listed']:,} · "
          f"crawled {stats['crawled']} · carried from the last crawl {len(industries) - stats['crawled']}")
    print(f"oldest crawl {payload['oldestCrawl']} · took {(time.time() - started) / 60:.1f} min")
    print(f"ticker file coverage {len(matched):,}/{len(tickers):,} ({covered:.1f}%) "
          f"registrants land in an industry")
    if _retried:
        print(f"  {_retried} requests were refused and retried")
    if stats["unreached"]:
        print(f"  {len(stats['unreached'])} due industries left for the next run: "
              f"{' '.join(stats['unreached'][:12])}{' ...' if len(stats['unreached']) > 12 else ''}")
    missing = [s for s in codes if s not in crawl]
    if missing:
        print(f"  {len(missing)} industries have never been crawled: {' '.join(missing[:12])}")
    if empty:
        print(f"  no filers under {len(empty)} codes: {' '.join(empty[:12])}")
    for sic in stats["capped"]:
        print(f"  {sic} hit the {MAX_PAGES}-page cap, so its filer count is a floor")
    for msg in stats["failed"]:
        print(f"  failed: {msg}")
    if len(body) > 8e6:
        print(f"  over the 8MB budget at {len(body) / 1e6:.2f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
