#!/usr/bin/env python3
"""
The peer collector's rolling refresh, offline.

    python3 scripts/__tests__/sync-peers.test.py

WHY THIS EXISTS
---------------
The monthly peer step timed out at ninety minutes on 24 September and wrote
nothing. EDGAR's company search costs six to eight seconds a page from a
runner, the whole catalogue is about 880 pages, and the collector wrote its
file once, at the end, from a cache that lived in a directory no run kept. So
every run was a cold crawl, and a cold crawl does not fit.

The fix is a crawl record committed beside the output and a time budget: a run
re-reads the industries most overdue, stops when the budget is spent, and
writes a complete file from what it read plus what the record already held.
What is pinned here is the part of that which would be expensive to discover
in production: the order industries are refreshed in, that a spent budget
still writes a whole file, that an industry cut off mid-crawl or failing keeps
its last crawl, and that a one-code run never writes a one-industry file.

EDGAR is replaced by a stub and the clock by a counter, so this runs in well
under a second and never touches the network.
"""

from __future__ import annotations

import importlib.util
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("sync_peers", ROOT / "scripts" / "sync_peers.py")
sp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sp)

passed = failed = 0


def check(name: str, cond: bool, detail: object = "") -> None:
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS  {name}")
    else:
        failed += 1
        print(f"FAIL  {name}{f' — {detail}' if detail != '' else ''}")


NOW = datetime.now(timezone.utc)
ago = lambda days: (NOW - timedelta(days=days)).isoformat()

# ── 1. which industries are due, and in what order ───────────────────────────
crawl = {
    "0100": {"ciks": ["1"], "pages": 1, "capped": False, "fetchedAt": ago(40)},
    "0200": {"ciks": ["2"], "pages": 1, "capped": False, "fetchedAt": ago(10)},
    "0700": {"ciks": ["3"], "pages": 1, "capped": False, "fetchedAt": ago(90)},
    "0800": {"ciks": ["4"], "pages": 1, "capped": False, "fetchedAt": "not a date"},
}
codes = ["0100", "0200", "0700", "0800", "0900"]
order = sp.refresh_order(codes, crawl, max_age_days=25, full=False, now=NOW)
check("never crawled comes first, then the oldest crawl", order == ["0800", "0900", "0700", "0100"], order)
check("an industry read ten days ago is not due", "0200" not in order, order)
standin = {**crawl, "0900": {"ciks": ["5"], "pages": 0, "capped": False, "fetchedAt": ago(2), "filers": 7}}
order = sp.refresh_order(codes, standin, max_age_days=25, full=False, now=NOW)
check("a stand-in from the published file is due however recent, after never-crawled", order == ["0800", "0900", "0700", "0100"], order)
full = sp.refresh_order(codes, crawl, max_age_days=25, full=True, now=NOW)
check("--full makes everything due, still most overdue first", full == ["0800", "0900", "0700", "0100", "0200"], full)

# ── 2. the crawl record survives a round trip ────────────────────────────────
with tempfile.TemporaryDirectory() as d:
    path = Path(d) / "crawl.json"
    path.write_text(json.dumps(sp.crawl_payload({"100": {"ciks": ["0000000042"], "pages": 1, "capped": False, "fetchedAt": ago(1)}})))
    raw = json.loads(path.read_text())
    check("CIKs are stored as integers", raw["industries"]["100"]["ciks"] == [42], raw)
    back = sp.load_crawl(path)
    check("and read back zero-padded, under a four-digit code", back == {"0100": {"ciks": ["0000000042"], "pages": 1, "capped": False, "fetchedAt": ago(1)}}, back)
    path.write_text("{ not json")
    with redirect_stdout(io.StringIO()):
        check("an unreadable record is a crawl not done, never a crash", sp.load_crawl(path) == {})
    check("a missing record is empty", sp.load_crawl(Path(d) / "absent.json") == {})


# ── 3. a whole run against a stubbed EDGAR ───────────────────────────────────
class Clock:
    """Each page costs `per_page` seconds of a budget measured in fake time."""

    def __init__(self, per_page: float):
        self.t = 1_000_000.0
        self.per_page = per_page

    def time(self) -> float:
        return self.t


def run(argv: list[str], *, members: dict[str, list[str]], record: dict | None,
        per_page: float = 7.0, broken: set[str] = frozenset(), published: dict | None = None):
    """Run main() in a scratch directory; return (exit code, output, crawl record, log)."""
    clock = Clock(per_page)
    pages_asked: list[str] = []

    def fake_get(url: str, *, accept: str = "", retries: int = 4) -> bytes:
        sic = url.split("SIC=")[1].split("&")[0]
        start = int(url.split("start=")[1].split("&")[0])
        pages_asked.append(sic)
        clock.t += clock.per_page
        if sic in broken:
            raise RuntimeError("EDGAR said no")
        page = members.get(sic, [])[start : start + sp.PAGE]
        return "".join(f"<cik>{c.zfill(10)}</cik>" for c in page).encode()

    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "peers.auto.json"
        crawl_path = Path(d) / "peers-crawl.auto.json"
        if record is not None:
            crawl_path.write_text(json.dumps(sp.crawl_payload(record)))
        if published is not None:
            out.write_text(json.dumps(published))
        saved = (sp.OUT, sp.CRAWL, sp.PRECEDENTS, sp.get, sp.sic_catalogue, sp.ticker_index, sp.time.time, sys.argv)
        sp.OUT, sp.CRAWL, sp.PRECEDENTS = out, crawl_path, Path(d) / "none.json"
        sp.get = fake_get
        sp.sic_catalogue = lambda: {c: f"Industry {c}" for c in members}
        sp.ticker_index = lambda: {"0000000001": ("AAA", "Alpha"), "0000000150": ("BBB", "Beta")}
        sp.time.time = clock.time
        sys.argv = ["sync_peers.py", *argv]
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                code = sp.main()
        finally:
            sp.OUT, sp.CRAWL, sp.PRECEDENTS, sp.get, sp.sic_catalogue, sp.ticker_index, sp.time.time, sys.argv = saved
        written = json.loads(out.read_text()) if out.exists() else None
        rec = json.loads(crawl_path.read_text()) if crawl_path.exists() else None
        return code, written, rec, buf.getvalue(), pages_asked


# Four industries: one of 250 filers (three pages), three of one page each.
MEMBERS = {
    "0100": [str(i) for i in range(1, 251)],
    "0200": ["1"],
    "0700": ["150"],
    "0800": ["9"],
}
OLD = {c: {"ciks": [str(x).zfill(10) for x in v], "pages": 1, "capped": False, "fetchedAt": ago(40)} for c, v in MEMBERS.items()}
OLD["0200"]["fetchedAt"] = ago(60)  # the most overdue

# Cold, no budget: the seeding run.
code, peers, rec, log, asked = run([], members=MEMBERS, record=None)
check("a cold run with no budget crawls everything", code == 0 and sorted(rec["industries"]) == sorted(MEMBERS), log)
check("and writes every industry", peers and sorted(peers["industries"]) == sorted(MEMBERS))
check("reading every page of the long one", asked.count("0100") == 3, asked)
check("the ticker join lands a listed company", peers["industries"]["0100"]["listed"][0]["ticker"] == "AAA")
check("the file says how old its oldest crawl is", bool(peers.get("oldestCrawl")))

# Warm, nothing due: two requests' worth of work and a complete file.
fresh = {c: {**v, "fetchedAt": ago(3)} for c, v in OLD.items()}
code, peers, rec, log, asked = run([], members=MEMBERS, record=fresh)
check("a warm run with nothing due reads no company-search page", asked == [], asked)
check("and still writes the whole file, restamped", code == 0 and len(peers["industries"]) == 4 and peers["generatedAt"] > ago(1))

# Budget: 20 seconds of fake time at 7 per page is two one-page industries,
# then the third is cut off. The 60-day-old one goes first.
code, peers, rec, log, asked = run(["--budget-minutes", str(20 / 60)], members=MEMBERS, record=OLD)
check("a spent budget still writes", code == 0 and peers is not None, log)
check("a complete file: every industry, crawled or carried", sorted(peers["industries"]) == sorted(MEMBERS), sorted(peers["industries"]))
check("the most overdue industry was refreshed first", asked[0] == "0200", asked)
check("it stopped when the budget ran out", len(asked) <= 4, asked)
refreshed = [c for c, v in rec["industries"].items() if v["fetchedAt"] > ago(1)]
check("what it reached is on record as fresh", "0200" in refreshed and len(refreshed) < 4, refreshed)
check("what it did not reach kept its last crawl", all(rec["industries"][c]["fetchedAt"] == OLD[c]["fetchedAt"] for c in MEMBERS if c not in refreshed))
check("the log says what is left for next time", "left for the next run" in log, log[-400:])

# An industry cut off mid-crawl is abandoned, not half-recorded.
code, peers, rec, log, asked = run(["--sic", "0100", "--budget-minutes", str(10 / 60)], members=MEMBERS, record=OLD)
check("an industry cut off mid-crawl keeps its whole last crawl", rec["industries"]["0100"] == {**sp.crawl_payload(OLD)["industries"]["0100"]}, rec["industries"]["0100"])
check("...and the log says so", "budget spent mid-industry" in log, log[-300:])

# A failing industry keeps its last crawl and stays in the file.
code, peers, rec, log, asked = run(["--full"], members=MEMBERS, record=OLD, broken={"0700"})
check("an industry EDGAR refused stays in the file", "0700" in peers["industries"], sorted(peers["industries"]))
check("from its last crawl", rec["industries"]["0700"]["fetchedAt"] == OLD["0700"]["fetchedAt"])
check("and the failure is reported", "failed: 0700" in log and "last crawl kept" in log, log[-400:])

# --sic narrows what is crawled, never what is written.
code, peers, rec, log, asked = run(["--sic", "800"], members=MEMBERS, record=OLD)
check("a one-code run crawls one code", set(asked) == {"0800"}, asked)
check("and still writes all four industries", sorted(peers["industries"]) == sorted(MEMBERS), sorted(peers["industries"]))

# No crawl record at all, but a published file: the first run after the
# record was introduced. A budget that reaches one industry still writes all
# four, the rest stood in for from the published file with its filer counts.
PUBLISHED = {
    "generatedAt": ago(16),
    "industries": {
        c: {"description": f"Industry {c}", "filers": len(v), "listed": [{"cik": "0000000001", "ticker": "AAA", "name": "Alpha"}] if "1" in v else []}
        for c, v in MEMBERS.items()
    },
}
code, peers, rec, log, asked = run(["--budget-minutes", str(8 / 60)], members=MEMBERS, record=None, published=PUBLISHED)
check("the first run without a record still writes every industry", code == 0 and sorted(peers["industries"]) == sorted(MEMBERS), log[-400:])
check("a stood-in industry keeps its published filer count", peers["industries"]["0100"]["filers"] == 250, peers["industries"]["0100"])
check("and its listed members, joined against today's tickers", [r["ticker"] for r in peers["industries"]["0100"]["listed"]] == ["AAA"])
stand = [c for c, v in rec["industries"].items() if "filers" in v]
check("the record marks what is a stand-in, so the next run reads it first", len(stand) >= 2 and all(c in MEMBERS for c in stand), rec["industries"])
check("the oldest crawl reported is the published file's", peers["oldestCrawl"] == PUBLISHED["generatedAt"], peers.get("oldestCrawl"))

# Nothing on record and nothing reachable: refuse rather than write an empty file.
code, peers, rec, log, asked = run(["--budget-minutes", "0"], members=MEMBERS, record=None)
check("nothing crawled and nothing on record writes nothing", code == 1 and peers is None, log[-200:])

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
