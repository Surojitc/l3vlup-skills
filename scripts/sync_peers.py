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

Incremental by default: an industry already crawled is read from .cache/peers
rather than fetched again, so a monthly re-run costs the codes it has not seen.
--full ignores the cache. --sic crawls one code. One industry's failure never
stops the run.

    python3 scripts/sync_peers.py
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
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "peers.auto.json"
CACHE = ROOT / ".cache" / "peers"
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


def filers_in(sic: str) -> tuple[list[str], int, bool]:
    """
    Every CIK EDGAR lists under one industry code, with a 10-K on file.

    The company search returns a hundred at a time in name order, so a single
    page is not an industry: for prepackaged software it is the companies
    beginning with A. Reading to the end is the whole point of collecting this
    ahead of time, since it is the part the site cannot afford to do live.

    Pages overlap slightly when a filer's name changes mid-crawl, so the list
    is deduplicated while keeping EDGAR's order. Returns the CIKs, the pages
    read, and whether the page cap cut the crawl short.
    """
    seen: set[str] = set()
    order: list[str] = []
    pages = 0
    while pages < MAX_PAGES:
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


def read_industry(sic: str, *, use_cache: bool) -> dict:
    """
    One industry's membership, cached on disk.

    The cache holds the CIKs rather than the finished rows, so a re-run joins
    them against a fresh ticker file: a company that listed since the last
    crawl gains its ticker without the industry being crawled again.
    """
    path = CACHE / f"{sic}.json"
    if use_cache and path.exists():
        try:
            cached = json.loads(path.read_text())
            cached["fromCache"] = True
            return cached
        except Exception:
            pass  # a truncated cache file is just a crawl we have not done
    ciks, pages, capped = filers_in(sic)
    record = {
        "sic": sic,
        "ciks": ciks,
        "pages": pages,
        "capped": capped,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, separators=(",", ":")))
    return {**record, "fromCache": False}


# ── the run ──────────────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--sic", action="append", help="crawl this code only (repeatable)")
    ap.add_argument("--limit", type=int, help="stop after this many industries")
    ap.add_argument("--full", action="store_true", help="re-crawl industries already cached")
    ap.add_argument("--out", type=Path, action="append", default=None,
                    help="write the output here as well as data/peers.auto.json")
    args = ap.parse_args()

    print("SIC code list")
    catalogue = sic_catalogue()
    print(f"  {len(catalogue)} codes published by the SEC")

    seeded = precedent_sics()
    extra = {c: d for c, d in seeded.items() if c not in catalogue}
    print(f"  {len(seeded)} codes carry a precedent transaction, "
          f"{len(extra)} of them outside the published list")
    for code, description in extra.items():
        catalogue[code] = description or f"SIC {code}"

    print("SEC ticker file")
    tickers = ticker_index()
    print(f"  {len(tickers)} registrants with a ticker\n")

    codes = sorted(catalogue)
    if args.sic:
        want = {pad(s) for s in args.sic}
        codes = [c for c in codes if c in want]
        for c in sorted(want - set(codes)):
            # A code nobody publishes can still be crawled: EDGAR answers for it
            # or it comes back empty, and either is an honest answer.
            codes.append(c)
            catalogue.setdefault(c, f"SIC {c}")
        codes.sort()
    if args.limit:
        codes = codes[: args.limit]

    print(f"{len(codes)} industries · cache {'ignored' if args.full else CACHE}\n")

    industries: dict[str, dict] = {}
    stats = {"crawled": 0, "cached": 0, "capped": [], "failed": [], "empty": []}
    matched: set[str] = set()

    for i, sic in enumerate(codes, 1):
        label = catalogue.get(sic) or f"SIC {sic}"
        try:
            record = read_industry(sic, use_cache=not args.full)
        except Exception as e:
            # One dead code is not a dead run.
            print(f"[{i:>3}/{len(codes)}] {sic} {label[:38]:<38} {type(e).__name__}: {e}")
            stats["failed"].append(f"{sic} {label}: {type(e).__name__}: {e}")
            continue

        stats["cached" if record["fromCache"] else "crawled"] += 1
        if record.get("capped"):
            stats["capped"].append(sic)

        listed = []
        for cik in record["ciks"]:
            hit = tickers.get(cik)
            if hit:
                listed.append({"cik": cik, "ticker": hit[0], "name": hit[1]})
                matched.add(cik)

        if not record["ciks"]:
            stats["empty"].append(sic)
        else:
            industries[sic] = {
                "description": label,
                "filers": len(record["ciks"]),
                "listed": listed,
            }

        pages = record.get("pages", 0)
        how = "from cache" if record["fromCache"] else f"{pages} page{'' if pages == 1 else 's'}"
        flag = "  CAPPED" if record.get("capped") else ""
        print(f"[{i:>3}/{len(codes)}] {sic} {label[:38]:<38} "
              f"{len(record['ciks']):>5} filers · {len(listed):>4} listed  ({how}){flag}")

    if not industries:
        print("nothing crawled, refusing to write a file")
        return 1

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": "EDGAR company search by SIC, and the SEC ticker file",
        "counts": {
            "industries": len(industries),
            "companies": sum(v["filers"] for v in industries.values()),
            "listed": sum(len(v["listed"]) for v in industries.values()),
        },
        "industries": dict(sorted(industries.items())),
    }

    body = json.dumps(payload, separators=(",", ":")) + "\n"
    for target in [OUT] + list(args.out or []):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body)
        print(f"\nwrote {target} ({len(body) / 1e6:.2f} MB)")

    c = payload["counts"]
    covered = len(matched) / len(tickers) * 100 if tickers else 0
    print(f"industries {c['industries']} · filers {c['companies']:,} · "
          f"listed {c['listed']:,} · crawled {stats['crawled']} · from cache {stats['cached']}")
    print(f"ticker file coverage {len(matched):,}/{len(tickers):,} ({covered:.1f}%) "
          f"registrants land in an industry")
    if _retried:
        print(f"  {_retried} requests were refused and retried")
    if stats["empty"]:
        print(f"  no filers under {len(stats['empty'])} codes: {' '.join(stats['empty'][:12])}")
    for sic in stats["capped"]:
        print(f"  {sic} hit the {MAX_PAGES}-page cap, so its filer count is a floor")
    for msg in stats["failed"]:
        print(f"  failed: {msg}")
    if len(body) > 8e6:
        print(f"  over the 8MB budget at {len(body) / 1e6:.2f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
