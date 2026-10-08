#!/usr/bin/env python3
"""
The 13F collector's amendment and status rules, offline.

    python3 scripts/__tests__/sync-funds.test.py

WHY THIS EXISTS
---------------
The collector used to read a period's original 13F-HR and apply an amendment
only when it restated the whole table. NEW HOLDINGS amendments, which add lines
the original left out, were counted and dropped. For Invesco that was 101
Nasdaq-100 lines, about $407bn, in each of 2025 Q4 and 2026 Q1, so the 2026 Q2
page read the lines' return as $583bn of buying. Notices (13F-NT) were ignored
too, so Pershing Square, whose holdings moved into its listed parent's report,
looked like a manager whose last book was current.

What is pinned here: how an amendment is applied (appended, summed, or treated
as the whole table it plainly is), the order amendments apply in, that a merged
prior quarter changes what reads as "new", whether a manager is current, behind
a notice, or overdue, the user agent coming from the environment, and the
honest counts beside the capped lists.

EDGAR is replaced by a stub; nothing here touches the network.
"""

from __future__ import annotations

import importlib.util
import io
import os
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load(env_ua: str | None = None):
    if env_ua is None:
        os.environ.pop("SEC_USER_AGENT", None)
    else:
        os.environ["SEC_USER_AGENT"] = env_ua
    spec = importlib.util.spec_from_file_location("sync_funds", ROOT / "scripts" / "sync_funds.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


sf = load()
passed = failed = 0


def check(name: str, cond: bool, detail: object = "") -> None:
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS  {name}")
    else:
        failed += 1
        print(f"FAIL  {name}{f' — {detail}' if detail != '' else ''}")


def pos(cusip, value, shares, cls="COM", issuer=None):
    return {"cusip": cusip, "issuer": issuer or cusip, "class": cls, "value": float(value), "shares": shares}


def filing(acc, holdings, *, quarter="2026Q1", period="2026-03-31", filed="2026-05-15"):
    total = sum(p["value"] for p in holdings)
    return {
        "accession": acc, "quarter": quarter, "periodOfReport": period, "filed": filed,
        "form": "13F-HR", "filingUrl": f"https://example/{acc}", "scale": 1.0,
        "aum": round(total / 1e6, 1), "positions": len(holdings),
        "top10Pct": None, "checks": {}, "holdings": sorted(holdings, key=lambda p: -p["value"]),
    }


# ── 1. merge_amendment ───────────────────────────────────────────────────────
base = filing("B", [pos("AAA", 600e6, 100), pos("BBB", 400e6, 50)])

# Invesco shape: lines the original left out, one of them a security already held.
extra = filing("X", [pos("CCC", 300e6, 30), pos("AAA", 60e6, 10)])
merged, mode = sf.merge_amendment(base, extra)
by = {p["cusip"]: p for p in merged["holdings"]}
check("new holdings: mode appended", mode == "appended", mode)
check("new holdings: new CUSIP joins the table", "CCC" in by)
check("new holdings: same CUSIP and class summed (value)", by["AAA"]["value"] == 660e6, by["AAA"])
check("new holdings: same CUSIP and class summed (shares)", by["AAA"]["shares"] == 110, by["AAA"])
check("new holdings: aum recomputed", merged["aum"] == 1360.0, merged["aum"])
check("new holdings: positions recomputed", merged["positions"] == 3, merged["positions"])
check("new holdings: largest first", [p["cusip"] for p in merged["holdings"]] == ["AAA", "BBB", "CCC"])
check("new holdings: top10Pct recomputed", merged["top10Pct"] == 1.0, merged["top10Pct"])
check("new holdings: the original's accession and link stand", merged["accession"] == "B" and merged["filingUrl"].endswith("/B"))
check("new holdings: base not mutated", len(base["holdings"]) == 2 and base["holdings"][0]["value"] == 600e6)

# A call option on a held stock is its own position, not a top-up of the stock.
opt = filing("X2", [pos("AAA", 5e6, 1, cls="COM CALL")])
merged_opt, _ = sf.merge_amendment(base, opt)
check("new holdings: different class stays a separate line",
      sum(1 for p in merged_opt["holdings"] if p["cusip"] == "AAA") == 2)

# First Eagle shape: the whole table again under the NEW HOLDINGS label, slightly larger.
whole = filing("W", [pos("AAA", 610e6, 101), pos("BBB", 400e6, 50), pos("DDD", 10e6, 5)])
got, mode = sf.merge_amendment(base, whole)
check("whole table by size: mode replaced", mode == "replaced", mode)
check("whole table by size: not doubled", got["aum"] == 1020.0, got["aum"])
check("whole table by size: the amendment's lines are the table", {p["cusip"] for p in got["holdings"]} == {"AAA", "BBB", "DDD"})

# Smaller than 90% but mostly the original's lines at identical share counts.
repeat = filing("R", [pos("AAA", 600e6, 100), pos("EEE", 50e6, 5)])
got, mode = sf.merge_amendment(base, repeat)
check("whole table by overlap: mode replaced", mode == "replaced", mode)

# Farallon shape: one late line worth more than the rest of a small original.
big = filing("G", [pos("NEW", 1500e6, 9)])
_, mode = sf.merge_amendment(base, big)
check("a large addition of new securities is still appended", mode == "appended", mode)

# Invesco shape: more shares of names already reported, below the size bar.
sleeve = filing("I", [pos("AAA", 400e6, 70), pos("BBB", 200e6, 20)])
_, mode = sf.merge_amendment(base, sleeve)
check("added shares of held names (different counts) are appended", mode == "appended", mode)

# A corrected whole table: same securities, revised share counts, full size.
corrected = filing("C", [pos("AAA", 640e6, 105), pos("BBB", 410e6, 51)])
_, mode = sf.merge_amendment(base, corrected)
check("a corrected whole table (same names, full size) is replaced", mode == "replaced", mode)

# An addition the size of a modest slice is an addition.
small = filing("S", [pos("FFF", 100e6, 10)])
_, mode = sf.merge_amendment(base, small)
check("a modest addition is appended", mode == "appended", mode)

# ── 2. build_manager: order of amendments, and the diff afterwards ──────────
def sub_of(rows, notices=()):
    forms, dates, filed, acc = [], [], [], []
    for form, period, fdate, a in list(rows) + list(notices):
        forms.append(form); dates.append(period); filed.append(fdate); acc.append(a)
    return {"name": "TEST CAPITAL", "addresses": {"business": {"stateOrCountry": "NY"}},
            "filings": {"recent": {"form": forms, "reportDate": dates, "filingDate": filed, "accessionNumber": acc}}}


def run_build(sub, tables, covers, notices_meta=None, today="2026-10-08"):
    """build_manager with read_filing, read_cover and read_notice stubbed."""
    def fake_read_filing(cik, f, use_cache=True):
        t = tables.get(f["accession"])
        if t is None:
            return None
        return filing(f["accession"], [dict(p) for p in t],
                      quarter=f["quarter"], period=f["periodOfReport"], filed=f["filed"])
    sf.read_filing = fake_read_filing
    sf.read_cover = lambda cik, acc, use_cache=True: covers.get(acc, {})
    sf.read_notice = lambda cik, acc, use_cache=True: (notices_meta or {}).get(acc, {})
    stats = {k: 0 for k in ("fetched", "cached", "filingErrors", "filingsEmpty", "amendmentsSkipped",
                            "amendmentsApplied", "amendmentsTreatedAsRestated", "tickerTried", "tickerHit")}
    stats.update({"totalMismatch": [], "failed": [], "notCurrent": []})
    with redirect_stdout(io.StringIO()):
        m = sf.build_manager({"name": "Test Capital"}, "0000000001", sub, 8,
                             use_cache=False, tickers={}, stats=stats, today=today)
    return m, stats


# EA shape: a position disclosed late for Q1 by amendment is held, not new, in Q2.
sub = sub_of([
    ("13F-HR", "2026-06-30", "2026-08-14", "Q2"),
    ("13F-HR/A", "2026-03-31", "2026-06-20", "Q1A"),
    ("13F-HR", "2026-03-31", "2026-05-15", "Q1"),
])
tables = {
    "Q2": [pos("AAA", 600e6, 100), pos("EA0", 1620e6, 9)],
    "Q1": [pos("AAA", 600e6, 100), pos("BBB", 400e6, 50)],
    "Q1A": [pos("EA0", 1520e6, 9)],
}
covers = {"Q1A": {"amendmentType": "NEW HOLDINGS"}}
m, stats = run_build(sub, tables, covers)
hold = {h["cusip"]: h for h in m["latest"]["holdings"]}
check("diff: a line added by last quarter's amendment is not 'new'", hold["EA0"]["action"] == "held", hold["EA0"]["action"])
check("diff: prevShares comes from the amended prior quarter", hold["EA0"]["prevShares"] == 9)
q1 = next(h for h in m["history"] if h["quarter"] == "2026Q1")
check("history: amended quarter's aum includes the added lines", q1["aum"] == 2520.0, q1["aum"])
check("history: amendedBy recorded", q1.get("amendedBy") == [{"accession": "Q1A", "filed": "2026-06-20", "mode": "appended"}], q1.get("amendedBy"))
check("stats: amendment counted as applied", stats["amendmentsApplied"] == 1 and stats["amendmentsSkipped"] == 0, stats)
check("exits: BBB left, counted in exitedTotal", m["latest"]["exitedTotal"] == 1 and len(m["latest"]["exited"]) == 1)

# Same-day RESTATEMENT and NEW HOLDINGS, and NEW HOLDINGS followed by a later RESTATEMENT.
sub = sub_of([
    ("13F-HR/A", "2026-06-30", "2026-09-01", "R2"),
    ("13F-HR/A", "2026-06-30", "2026-08-20", "N2"),
    ("13F-HR/A", "2026-06-30", "2026-08-20", "N1"),
    ("13F-HR", "2026-06-30", "2026-08-14", "O"),
])
tables = {
    "O": [pos("AAA", 100e6, 10)],
    "R1": [pos("AAA", 120e6, 12)],
    "N1": [pos("AAA", 120e6, 12)],
    "N2": [pos("ZZZ", 5e6, 1)],
    "R2": [pos("AAA", 130e6, 13), pos("ZZZ", 5e6, 1)],
}
# Same filing day: EDGAR's accession sequence decides; N1 (restatement) precedes N2.
covers = {"R1": {"amendmentType": "RESTATEMENT"}, "N1": {"amendmentType": "RESTATEMENT"},
          "N2": {"amendmentType": "NEW HOLDINGS"}, "R2": {"amendmentType": "RESTATEMENT"}}
m, _ = run_build(sub, tables, covers, today="2026-09-10")
check("a later restatement replaces the table and the additions before it",
      m["latest"]["aum"] == 135.0 and m["latest"]["positions"] == 2 and "amendedBy" not in m["latest"], m["latest"])

sub = sub_of([
    ("13F-HR/A", "2026-06-30", "2026-08-20", "N2"),
    ("13F-HR/A", "2026-06-30", "2026-08-20", "N1"),
    ("13F-HR", "2026-06-30", "2026-08-14", "O"),
])
m, _ = run_build(sub, tables, covers, today="2026-09-10")
check("same-day restatement then addition (accession order): both stand",
      m["latest"]["aum"] == 125.0 and m["latest"]["positions"] == 2, m["latest"]["aum"])

# An amendment of an unknown type is still skipped and counted.
sub = sub_of([("13F-HR/A", "2026-06-30", "2026-08-20", "U"), ("13F-HR", "2026-06-30", "2026-08-14", "O")])
m, stats = run_build(sub, {"O": [pos("AAA", 100e6, 10)], "U": [pos("QQQ", 1e6, 1)]}, {"U": {"amendmentType": "SOMETHING ELSE"}}, today="2026-09-10")
check("unknown amendment type: skipped, table unchanged", m["latest"]["positions"] == 1 and stats["amendmentsSkipped"] == 1)

# ── 3. the cap: what the list covers, and the exits it does not print ───────
orig_cap, orig_exit = sf.HOLDINGS_CAP, sf.EXITED_CAP
sf.HOLDINGS_CAP, sf.EXITED_CAP = 2, 1
sub = sub_of([("13F-HR", "2026-06-30", "2026-08-14", "Q2"), ("13F-HR", "2026-03-31", "2026-05-15", "Q1")])
tables = {
    "Q2": [pos("AAA", 50e6, 5), pos("BBB", 30e6, 3), pos("CCC", 20e6, 2)],
    "Q1": [pos("AAA", 50e6, 5), pos("X1", 9e6, 1), pos("X2", 8e6, 1), pos("X3", 7e6, 1)],
}
m, _ = run_build(sub, tables, {})
lat = m["latest"]
check("cap: two rows printed of three", len(lat["holdings"]) == 2 and lat["positions"] == 3)
check("cap: holdingsCapped", lat["holdingsCapped"] is True)
check("cap: holdingsValuePct is the printed share of the book", lat["holdingsValuePct"] == 0.8, lat["holdingsValuePct"])
check("exits: one printed, three counted", len(lat["exited"]) == 1 and lat["exitedTotal"] == 3, lat["exitedTotal"])
sf.HOLDINGS_CAP, sf.EXITED_CAP = orig_cap, orig_exit

# ── 4. filer_status ──────────────────────────────────────────────────────────
check("due period: 8 Oct 2026 owes Q2 2026", sf.latest_due_period("2026-10-08") == "2026-06-30")
check("due period: 15 Aug 2026 still inside grace for Q2", sf.latest_due_period("2026-08-15") == "2026-03-31")
check("due period: 1 Mar 2026 owes Q4 2025", sf.latest_due_period("2026-03-01") == "2025-12-31")
check("status: current", sf.filer_status("2026-06-30", [], "2026-10-08") == {"status": "current"})
check("status: overdue a quarter", sf.filer_status("2026-03-31", [], "2026-10-08") == {"status": "overdue", "period": "2026Q2"})
nt = [{"form": "13F-NT", "periodOfReport": "2026-06-30", "quarter": "2026Q2", "filed": "2026-08-14",
       "reportedBy": {"cik": "0002026053", "name": "PERSHING SQUARE INC.", "fileNumber": "028-25746"}}]
st = sf.filer_status("2026-03-31", nt, "2026-10-08")
check("status: notice names who reports the holdings",
      st["status"] == "notice" and st["period"] == "2026Q2" and st["reportedBy"]["cik"] == "0002026053", st)
old_nt = [dict(nt[0], periodOfReport="2025-12-31", quarter="2025Q4")]
check("status: an old notice before the latest report does not count",
      sf.filer_status("2026-06-30", old_nt, "2026-10-08") == {"status": "current"})

# A notice, as EDGAR writes it (Pershing Square, 2026 Q2, trimmed).
NT_XML = """<?xml version="1.0" encoding="UTF-8"?>
<edgarSubmission xmlns="http://www.sec.gov/edgar/thirteenffiler" xmlns:ns1="http://www.sec.gov/edgar/common">
  <schemaVersion>X0202</schemaVersion>
  <headerData><submissionType>13F-NT</submissionType></headerData>
  <formData><coverPage>
    <reportCalendarOrQuarter>06-30-2026</reportCalendarOrQuarter>
    <filingManager><name>Pershing Square Capital Management, L.P.</name></filingManager>
    <reportType>13F NOTICE</reportType>
    <otherManagersInfo><otherManager>
      <cik>0002026053</cik><form13FFileNumber>028-25746</form13FFileNumber><name>PERSHING SQUARE INC.</name>
    </otherManager></otherManagersInfo>
  </coverPage></formData>
</edgarSubmission>"""
check("parse_notice: the other manager's CIK, name and file number",
      sf.parse_notice(NT_XML) == {"cik": "0002026053", "name": "PERSHING SQUARE INC.", "fileNumber": "028-25746"},
      sf.parse_notice(NT_XML))
check("parse_notice: a notice naming nobody gives nothing",
      sf.parse_notice(NT_XML.replace("<otherManagersInfo>", "<x>").replace("</otherManagersInfo>", "</x>").replace("otherManager", "y")) == {})

sub = sub_of([("13F-HR", "2026-03-31", "2026-05-15", "Q1")], notices=[("13F-NT", "2026-06-30", "2026-08-14", "NT2")])
m, stats = run_build(sub, {"Q1": [pos("AAA", 1e6, 1)]}, {},
                     notices_meta={"NT2": {"cik": "0002026053", "name": "PERSHING SQUARE INC."}})
check("build: notice status on the manager", m["status"]["status"] == "notice" and m["status"]["reportedBy"]["cik"] == "0002026053", m["status"])
check("build: a notice is not a holdings report (latest stays Q1)", m["latest"]["quarter"] == "2026Q1")
check("build: not-current managers listed in the run", len(stats["notCurrent"]) == 1)
check("filings_13f ignores notices", all(f["form"].startswith("13F-HR") for f in sf.filings_13f(sub)))

# ── 5. the user agent ────────────────────────────────────────────────────────
check("user agent: fallback contact without the environment", "contact@l3vlup.com" in sf.UA, sf.UA)
sf_env = load("L3VLUP data desk data@example.com")
check("user agent: SEC_USER_AGENT wins", sf_env.UA == "L3VLUP data desk data@example.com", sf_env.UA)
sf_blank = load("   ")
check("user agent: a blank variable falls back", "contact@l3vlup.com" in sf_blank.UA, sf_blank.UA)
os.environ.pop("SEC_USER_AGENT", None)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
