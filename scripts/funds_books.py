#!/usr/bin/env python3
"""
Every tracked manager's complete 13F information table for the recent quarters.

    python3 scripts/funds_books.py                  # every manager, within the request budget
    python3 scripts/funds_books.py --budget 300     # at most 300 SEC requests this run
    python3 scripts/funds_books.py --manager 1067983
    python3 scripts/funds_books.py --check          # say what would be read, read nothing

WHY THIS EXISTS
---------------
The history (scripts/funds_history.py) stores each quarter to its largest 500
positions. For a manager's own page that is the book. For the 13F Explorer's
change figures it is not enough: a position moving across the 500-line looks
like a new position or an exit, and a share change cannot be summed across
managers when one side of it sits below the line. So for the last four
quarters (ending at the Explorer's default quarter, plus any newer quarter
already filed) every manager's whole table is kept here, compactly:

    data/funds/books/<id>/<quarter>.json
    { schema, id, quarter, periodOfReport, filed, cik, accession, signature,
      aumK, positions, fields: [cusip, class, valueK, shares, putCall],
      rows: [[cusip, class, valueK, shares, putCall|null], ...] }

Values are thousands of dollars, rounded as the history rounds them; `class`
is the title of class as filed with any PUT or CALL moved into `putCall`.
Docs: docs/13f-explorer-2026-11.md in the site repository, "Round two".

The same filing, read the same way
----------------------------------
A book is the quarter the history chose: the same filing and amendments,
planned by the same functions (sync_funds.quarter_filings, plan_quarters) and
read by the same read_quarter, so restatements replace and NEW HOLDINGS
amendments add exactly as they do there. A book records the `signature` (the
accessions it was read from) and is written only when it equals the history's
signature for that quarter. Where the two disagree the history has not caught
up with an amendment yet; the book is left alone and read on a later run.

Incremental and bounded
-----------------------
A book whose signature equals the history's is never read again, so a run
between filing seasons makes no SEC request at all. Each run spends at most
`--budget` requests (counted here, request by request), newest quarters first,
so a cold start spreads over several runs. Requests keep sync_funds' gap
(0.15 s, under seven a second), carry SEC_USER_AGENT, read the filing cache
under .cache/funds first, and stop the run at the first 403 or 429: EDGAR
asking us to slow down is answered by stopping, not by retrying.

Standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sync_funds as sf  # noqa: E402
import funds_explorer as fe  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
HISTORY = ROOT / "data" / "funds" / "history"
OUT_DIR = ROOT / "data" / "funds" / "books"

SCHEMA = 1
QUARTERS = 4            # books kept, ending at the default quarter (newer quarters too)
DEFAULT_BUDGET = 1200   # SEC requests a run may spend
GAP = 0.15              # seconds between requests, as sync_funds.get
FIELDS = ["cusip", "class", "valueK", "shares", "putCall"]
RIGHTS = ("PUT", "CALL")

UA_DEFAULT = "L3VLUP Research (contact: suro@l3vlup.com)"


# ── the books to keep (pure) ─────────────────────────────────────────────────

def book_quarters(filed: dict[str, dict[str, dict]], n: int = QUARTERS) -> list[str]:
    """
    The quarters to keep complete books for, newest first: the n ending at
    the Explorer's default quarter, and every newer quarter any manager has
    filed. With no default (too few filers anywhere), the newest n.
    """
    qs = fe.window(filed, n=10_000)
    default = fe.default_quarter(fe.coverage(filed, qs), qs)
    if default is None:
        return qs[:n]
    newer = [q for q in qs if fe.quarter_key(q) > fe.quarter_key(default)]
    older = [q for q in qs if fe.quarter_key(q) <= fe.quarter_key(default)][:n]
    return newer + older


def book_rows(holdings: list[dict]) -> list[list]:
    """read_quarter's positions (dollars, PUT/CALL folded into class) as compact rows, largest first."""
    out = []
    for p in holdings:
        cls = (p.get("class") or "").strip()
        put_call = None
        up = cls.upper()
        for r in RIGHTS:
            if up.endswith(r):
                put_call = r
                cls = cls[: -len(r)].strip()
                break
        out.append([p["cusip"], cls, int(round(p["value"] / 1e3)), int(p["shares"]), put_call])
    out.sort(key=lambda r: (-r[2], r[0], r[1], r[4] or ""))
    return out


def book_body(mid: str, got: dict, signature: list[str]) -> dict:
    rows = book_rows(got["holdings"])
    return {
        "schema": SCHEMA, "id": mid, "quarter": got["quarter"], "periodOfReport": got["periodOfReport"],
        "filed": got["filed"], "cik": got["cik"], "accession": got["accession"], "signature": signature,
        "aumK": int(round(sum(p["value"] for p in got["holdings"]) / 1e3)),
        "positions": len(rows), "fields": FIELDS, "rows": rows,
    }


def dumps(body: dict) -> str:
    return json.dumps(body, separators=(",", ":"), ensure_ascii=False) + "\n"


def read_book(path: Path) -> dict | None:
    try:
        d = json.loads(path.read_text())
    except Exception:
        return None
    return d if d.get("schema") == SCHEMA and isinstance(d.get("rows"), list) else None


def plan(indexes: list[dict], out: Path, want: list[str]) -> list[tuple[str, str, list[str], str]]:
    """
    (manager id, quarter, the history's signature, period end) for every book
    that is missing or whose signature no longer matches the history's.
    Newest quarter first, then manager id.
    """
    todo = []
    for idx in indexes:
        for q in idx.get("quarters", []):
            if q["quarter"] not in want or not q.get("signature"):
                continue
            have = read_book(out / idx["id"] / f"{q['quarter']}.json")
            if have and have.get("signature") == q["signature"]:
                continue
            todo.append((idx["id"], q["quarter"], q["signature"], q["periodOfReport"]))
    todo.sort(key=lambda t: (tuple(-x for x in fe.quarter_key(t[1])), t[0]))
    return todo


# ── HTTP: counted, paced, and stopped by EDGAR's refusal ────────────────────

class Refused(Exception):
    """EDGAR answered 403 or 429: stop the run."""


class Counter:
    def __init__(self, budget: int):
        self.budget = budget
        self.made = 0
        self.last = 0.0

    def left(self) -> int:
        return self.budget - self.made

    def get(self, url: str, *, accept: str = "application/json", retries: int = 3) -> bytes:
        err = None
        for attempt in range(retries):
            wait = self.last + GAP - time.time()
            if wait > 0:
                time.sleep(wait)
            self.last = time.time()
            self.made += 1
            req = urllib.request.Request(url, headers={"User-Agent": sf.UA, "Accept": accept,
                                                       "Accept-Encoding": "identity"})
            try:
                with urllib.request.urlopen(req, timeout=120) as res:
                    return res.read()
            except urllib.error.HTTPError as e:
                if e.code in (403, 429):
                    raise Refused(f"{e.code} from {url}")
                if e.code == 404:
                    raise
                err = e
            except Exception as e:  # transient DNS, reset connection, read timeout
                err = e
            time.sleep(1.5 * (attempt + 1))
        raise RuntimeError(f"{url} failed after {retries} attempts: {err}")


# ── the run ──────────────────────────────────────────────────────────────────

def load_indexes(root: Path) -> list[dict]:
    out = []
    for folder in sorted(p for p in (root / "data" / "funds" / "history").iterdir() if p.is_dir()):
        idx = fe.read_json(folder / "index.json")
        if idx and idx.get("id") and isinstance(idx.get("quarters"), list):
            out.append(idx)
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--budget", type=int, default=DEFAULT_BUDGET, help="most SEC requests this run")
    ap.add_argument("--manager", action="append", help="a CIK (any of the manager's filers); repeatable")
    ap.add_argument("--quarters", type=int, default=QUARTERS, help="books kept, ending at the default quarter")
    ap.add_argument("--out", type=Path, default=OUT_DIR)
    ap.add_argument("--check", action="store_true", help="say what would be read; read and write nothing")
    args = ap.parse_args(argv)

    sf.UA = os.environ.get("SEC_USER_AGENT", "").strip() or UA_DEFAULT
    http = Counter(args.budget)
    sf.get = http.get  # every sync_funds reader (submissions, covers, tables) goes through the counter

    indexes = load_indexes(ROOT)
    want = book_quarters(fe.filings(indexes), args.quarters)
    entries = {(e.get("id") or sf.slugify(e["name"])): e for e in sf.load_universe()["managers"]}
    if args.manager:
        ciks = {c.zfill(10) for c in args.manager}
        entries = {k: e for k, e in entries.items() if ciks & {f["cik"] for f in sf.entry_filers(e)}}
    indexes = [i for i in indexes if i["id"] in entries]
    todo = plan(indexes, args.out, want)
    on_disk = sum(1 for i in indexes for q in i["quarters"] if q["quarter"] in want)
    print(f"books for {', '.join(want)} · {on_disk} manager-quarters filed · {len(todo)} to read · "
          f"budget {args.budget} requests · UA {sf.UA!r}")
    if args.check:
        for mid, q, sig, _p in todo:
            print(f"  {mid} {q} {' '.join(sig)}")
        return 0

    stats = {k: 0 for k in ("fetched", "cached", "filingErrors", "filingsEmpty", "amendmentsSkipped",
                            "amendmentsApplied", "amendmentsTreatedAsRestated")}
    stats["totalMismatch"] = []
    by_id = {i["id"]: i for i in indexes}
    sources: dict[str, list] = {}
    written = skipped = 0
    pending: list[str] = []
    refused = None
    for mid, q, sig, period in todo:
        if refused or http.left() <= 0:
            pending.append(f"{mid} {q}")
            continue
        entry = entries[mid]
        try:
            if mid not in sources:
                sources[mid] = [(f, sf.submissions(f["cik"], quarters=args.quarters + 2))
                                for f in sf.entry_filers(entry)]
            filings = [f for f in sf.quarter_filings(sources[mid]) if f["periodOfReport"] == period]
            planned = sf.plan_quarters(filings, periods={period}, use_cache=True, stats=stats)
            if not planned:
                print(f"  {mid} {q}: no filing for {period} in the submissions read")
                skipped += 1
                continue
            f = planned[0]
            if sf.quarter_signature(f) != sig:
                print(f"  {mid} {q}: filings read {sf.quarter_signature(f)} differ from the history's {sig};"
                      " left for the history to catch up")
                skipped += 1
                continue
            got = sf.read_quarter(entry, f, use_cache=True, stats=stats)
        except Refused as e:
            refused = str(e)
            pending.append(f"{mid} {q}")
            continue
        except Exception as e:
            print(f"  {mid} {q}: {type(e).__name__}: {e}")
            skipped += 1
            continue
        if got is None:
            skipped += 1
            continue
        body = book_body(mid, got, sig)
        hq = next(x for x in by_id[mid]["quarters"] if x["quarter"] == q)
        if body["positions"] != hq.get("positions") or body["aumK"] != hq.get("aumK"):
            print(f"  {mid} {q}: book {body['positions']} positions / {body['aumK']}K against the history's "
                  f"{hq.get('positions')} / {hq.get('aumK')}K")
        path = args.out / mid / f"{q}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        text = dumps(body)
        if not (path.exists() and path.read_text() == text):
            path.write_text(text)
            written += 1
        print(f"  {mid:<40} {q} {body['positions']:>6} positions  {len(text) / 1e3:>8,.0f} KB  "
              f"requests {http.made}")

    total = sum(p.stat().st_size for p in args.out.rglob("*.json")) if args.out.exists() else 0
    count = sum(1 for _ in args.out.rglob("*.json")) if args.out.exists() else 0
    print(f"\nwrote {written} books · skipped {skipped} · pending {len(pending)} · requests {http.made} · "
          f"filings fetched {stats['fetched']}, from cache {stats['cached']} · "
          f"on disk {count} books, {total / 1e6:,.1f} MB")
    for msg in stats["totalMismatch"]:
        print(f"  value total: {msg}")
    if refused:
        print(f"stopped: EDGAR refused ({refused}); {len(pending)} books left to a later run")
    return 0


if __name__ == "__main__":
    sys.exit(main())
