#!/usr/bin/env python3
"""
Every re-read pass does the filings of the last 24 months first, and a pass
cut short by its budget still reaches the older rows on later runs.

    python3 scripts/__tests__/precedent-recent-first.test.py

WHY THIS EXISTS
---------------
On 22 October 2026 review run 3 re-read the database under new reader
versions, oldest filing first, inside fixed per-pass budgets (de-SPAC check
20 minutes, target pass 15, premium and offer re-read, financials). It hit
those budgets before reaching 182 ok rows, almost all filed between September
2025 and October 2026. They kept the 11 October reading, and Finance OS's
default Premiums Paid sample, drawn from recent deals, fell to 24.

Each pass now orders its due rows with filings.recent_first: the last
RECENT_MONTHS first, then the rest, its own priority kept inside each group.
The de-SPAC check keeps its shell tier first and puts recency after it
(formindex.spac_check_order says why).

WHAT THIS SHOWS
---------------
For each pass, with EDGAR and the reader replaced by stand-ins and the clock by
one that moves a second per row: the order rows are read in, and a budget of
a few rows run again and again. Rows a run does not reach keep their reader
version, so they are still due; every row, old ones included, is read exactly
once over the runs; and a run after the last reads nothing.
"""

from __future__ import annotations

import copy
import math
import os
import sys
import types
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from precedent_transactions import filings, formindex  # noqa: E402

passed = failed = 0


def eq(name, got, want):
    global passed, failed
    if got == want:
        passed += 1
        print(f"PASS  {name}")
    else:
        failed += 1
        print(f"FAIL  {name}\n      got  {got!r}\n      want {want!r}")


# ── the cut-off ───────────────────────────────────────────────────────────────

eq("24 months before the finding", filings.recent_cutoff(date(2026, 10, 22)), "2024-10-22")
eq("a 29 February goes back to the 28th", filings.recent_cutoff(date(2028, 2, 29)), "2026-02-28")
eq("a December", filings.recent_cutoff(date(2026, 12, 31)), "2024-12-31")
eq("a January", filings.recent_cutoff(date(2026, 1, 15)), "2024-01-15")
eq("the cut-off day itself is recent", filings.is_recent({"filed": "2024-10-22"}, "2024-10-22"), True)
eq("the day before is not", filings.is_recent({"filed": "2024-10-21"}, "2024-10-22"), False)
eq("a row with no filing date is dated by its announcement", filings.is_recent({"announced": "2025-01-01"}, "2024-10-22"), True)
eq("a row with neither is not recent", filings.is_recent({}, "2024-10-22"), False)
eq("recent_first keeps the given order inside each group when no key is given",
   filings.recent_first(["o1", "r1", "o2", "r2"], {"o1": {"filed": "2015-01-01"}, "r1": {"filed": "2026-01-01"}, "o2": {"filed": "2012-01-01"}, "r2": {"filed": "2025-06-01"}}, today=date(2026, 10, 22)),
   ["r1", "r2", "o1", "o2"])

# ── stand-ins: a clock that moves a second per row read, and no EDGAR ──────────

TODAY = date.today()


def ago(days: int) -> str:
    return (TODAY - timedelta(days=days)).isoformat()


class Clock:
    def __init__(self):
        self.now = 0.0

    def time(self):
        return self.now


clock = Clock()
filings.time = types.SimpleNamespace(time=clock.time)
formindex.time = types.SimpleNamespace(time=clock.time)
filings.fetch = lambda url, cap=None: b""
filings.to_text = lambda raw: ""
read: list[str] = []


def reading(stamp):
    """A stand-in reader: records the row, brings it to the current version, takes a second."""
    def fake(row, *a, **k):
        read.append(row["id"])
        stamp(row)
        clock.now += 1
        return row
    return fake


filings.reread_securities = reading(lambda r: r.update(securitiesReader=filings.SECURITIES_READER))
filings.judge_target = reading(lambda r: r.update(targetReader=filings.TARGET_READER))
filings.reread_premiums = reading(lambda r: r.update(premiumReader=filings.PREMIUM_READER, announcedReader=filings.ANNOUNCED_READER, offerReader=filings.OFFER_READER))
filings.reread_financials = reading(lambda r: r.update(financialsReader=filings.FINANCIALS_READER))
formindex.judge_spac = reading(lambda r: r.update(spacRule=formindex.SPAC_RULE))


def run(pass_fn, rows, env, per_run=None):
    """One run of a pass. `per_run` rows fit its budget (the clock moves a second a row); None is unlimited."""
    os.environ[env] = str(10_000 if per_run is None else (per_run - 1) / 60)
    del read[:]
    clock.now = 0.0
    pass_fn(rows)
    return list(read)


# One fixture per pass: recent and old rows interleaved in the file's order,
# each due under that pass, plus rows that are not due and must never be read.
DOC = {"documentsRead": ["https://www.sec.gov/Archives/x.htm"], "status": "ok"}

PASSES = {
    "premium and offer re-read": dict(
        env="PRECEDENTS_REREAD_MINUTES",
        due=filings.needs_premium_reread,
        call=lambda rows: filings.reread_stale_premiums(rows, list(rows), lambda r: None),
        rows={
            "o-2014": {**DOC, "filed": "2014-03-01", "premiumReader": 1},
            "r-300": {**DOC, "filed": ago(300), "premiumReader": 1},
            "o-2019": {**DOC, "filed": "2019-07-01", "offerReader": 1},
            "r-40": {**DOC, "filed": ago(40), "announcedReader": 1},
            "o-2011": {**DOC, "filed": "2011-01-01", "premiumReader": 1},
            "r-700": {**DOC, "filed": ago(700), "premiumReader": 1},
            "current": {**DOC, "filed": ago(20), "premiumReader": filings.PREMIUM_READER, "announcedReader": filings.ANNOUNCED_READER, "offerReader": filings.OFFER_READER},
        },
        # oldest first inside each group, as the pass always ordered
        want=["r-700", "r-300", "r-40", "o-2011", "o-2014", "o-2019"],
    ),
    "target pass": dict(
        env="PRECEDENTS_TARGET_MINUTES",
        due=filings.needs_target_reread,
        call=lambda rows: filings.reread_stale_targets(rows, list(rows), lambda r: None),
        rows={
            "o-2016": {**DOC, "source": "DEFM14A", "filed": "2016-05-01"},
            "r-90": {**DOC, "source": "DEFM14C", "filed": ago(90)},
            "o-2021": {**DOC, "source": "DEFM14A", "filed": "2021-02-01"},
            "r-500": {**DOC, "source": "DEFM14A", "filed": ago(500)},
            "o-2010": {**DOC, "source": "DEFM14A", "filed": "2010-09-01"},
            "13e3": {**DOC, "source": "SC 13E3", "filed": ago(10)},
            "current": {**DOC, "source": "DEFM14A", "filed": ago(5), "targetReader": filings.TARGET_READER},
        },
        want=["r-500", "r-90", "o-2010", "o-2016", "o-2021"],
    ),
    "financials": dict(
        env="PRECEDENTS_FINANCIALS_MINUTES",
        due=filings.needs_financials_reread,
        call=lambda rows: filings.reread_stale_financials(rows, list(rows), lambda r: None),
        rows={
            # within each group: a request first (facts read under an earlier
            # concept list), an incomplete row first among those, then a row
            # whose only change is the version; oldest first after that
            "o-ask-done": {"status": "ok", "offerPrice": 21.0, "filed": "2013-01-01", "financialsReader": 1, "ltmRevenue": 5.0, "ltmEbitda": 1.0},
            "r-stamp": {"status": "ok", "offerPrice": 21.0, "filed": ago(60), "financialsReader": 4, "ltmRevenue": 5.0, "ltmEbitda": 1.0},
            "o-ask-gap": {"status": "ok", "offerPrice": 21.0, "filed": "2018-01-01", "financialsReader": 1},
            "r-ask-done": {"status": "ok", "offerPrice": 21.0, "filed": ago(400), "financialsReader": 2, "ltmRevenue": 5.0, "ltmEbitda": 1.0},
            "o-stamp": {"status": "ok", "offerPrice": 21.0, "filed": "2012-01-01", "financialsReader": 4, "ltmRevenue": 5.0, "ltmEbitda": 1.0},
            "r-ask-gap": {"status": "ok", "offerPrice": 21.0, "filed": ago(200), "financialsReader": 1},
            "unpriced": {"status": "ok", "offerPrice": None, "filed": ago(30), "financialsReader": 1},
        },
        want=["r-ask-gap", "r-ask-done", "r-stamp", "o-ask-gap", "o-ask-done", "o-stamp"],
    ),
    "securities-class covers": dict(
        env="PRECEDENTS_SECURITIES_MINUTES",
        due=filings.needs_securities_reread,
        call=lambda rows: filings.reread_stale_securities(rows, list(rows), lambda r: None),
        rows={
            # as the ids come (the file is written newest announcement first), recent first
            "r-100": {**DOC, "source": "SC 13E3", "filed": ago(100)},
            "o-2020": {**DOC, "source": "SC 13E3", "filed": "2020-03-01"},
            "r-600": {**DOC, "source": "SC 13E3", "filed": ago(600)},
            "o-2017": {**DOC, "source": "SC 13E3", "filed": "2017-03-01"},
            "proxy": {**DOC, "source": "DEFM14A", "filed": ago(10)},
        },
        want=["r-100", "r-600", "o-2020", "o-2017"],
    ),
    "de-SPAC check": dict(
        env="PRECEDENTS_SPAC_MINUTES",
        due=formindex.needs_spac_check,
        call=lambda rows: formindex.check_stale_spac(rows, lambda r: None),
        rows={
            "rest-2012": {**DOC, "source": "DEFM14A", "filed": "2012-06-01", "offerPrice": 30.0},
            "boom-2019": {**DOC, "source": "DEFM14A", "filed": "2019-06-01", "offerPrice": 25.0},
            "r-50": {**DOC, "source": "DEFM14A", "filed": ago(50), "offerPrice": 44.0},
            "shell-2015": {**DOC, "source": "DEFM14A", "filed": "2015-06-01", "offerPrice": 10.0},
            "boom-2022": {**DOC, "source": "DEFM14C", "filed": "2022-06-01", "offerPrice": 18.0},
            "r-shell": {**DOC, "source": "DEFM14A", "filed": ago(70), "offerPrice": 33.0, "acquirer": "Landcadia Acquisition Corp."},
            "r-500": {**DOC, "source": "DEFM14A", "filed": ago(500), "offerPrice": 12.0},
            "rest-2016": {**DOC, "source": "DEFM14A", "filed": "2016-06-01", "offerPrice": 50.0},
            "judged": {**DOC, "source": "DEFM14A", "filed": ago(5), "offerPrice": 10.0, "spacRule": formindex.SPAC_RULE},
        },
        # the shell tier first, whenever filed; then the last 24 months; then
        # the boom; then the rest; newest first within each
        want=["r-shell", "shell-2015", "r-50", "r-500", "boom-2022", "boom-2019", "rest-2016", "rest-2012"],
    ),
}

for name, p in PASSES.items():
    for rid, r in p["rows"].items():
        r["id"] = rid
    due = [rid for rid, r in p["rows"].items() if p["due"](r)]
    eq(f"{name}: the fixture's due rows are the ones expected", sorted(due), sorted(p["want"]))

    rows = copy.deepcopy(p["rows"])
    eq(f"{name}: recent filings first, the pass's own order kept inside each group", run(p["call"], rows, p["env"]), p["want"])

    # A budget of three rows a run, run until nothing is left.
    rows = copy.deepcopy(p["rows"])
    per = 3
    first = run(p["call"], rows, p["env"], per_run=per)
    eq(f"{name}: a run cut short by its budget reads the first {per}, recent first", first, p["want"][:per])
    eq(f"{name}: ...and every row it did not reach is still due, so the next run starts on it",
       [rid for rid in p["want"][per:] if p["due"](rows[rid])], p["want"][per:])
    seen = list(first)
    runs = 1
    while runs < 10:
        got = run(p["call"], rows, p["env"], per_run=per)
        if not got:
            break
        seen += got
        runs += 1
    eq(f"{name}: over later runs every row is read, old ones included, each exactly once, in order", seen, p["want"])
    eq(f"{name}: ...in as many runs as the budget allows, and then nothing is left", (runs, [rid for rid, r in rows.items() if p["due"](r)]), (math.ceil(len(p["want"]) / per), []))
    eq(f"{name}: a row that was never due is never read", sorted(set(p["rows"]) - set(seen)), sorted(set(p["rows"]) - set(p["want"])))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
