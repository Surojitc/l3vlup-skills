#!/usr/bin/env python3
"""
Every quarter of a manager's 13F book since the filings became machine-readable.

    python3 scripts/funds_history.py                       # every manager, within the budget
    python3 scripts/funds_history.py --manager 1067983     # one manager (any of its filers' CIKs)
    python3 scripts/funds_history.py --budget 400          # read at most 400 quarters this run
    python3 scripts/funds_history.py --since 2016-03-31    # a later floor

WHY THIS EXISTS
---------------
data/funds.auto.json is a snapshot: eight quarters per manager, the largest 200
positions of the latest one, and nothing older. That answers "what does this
manager own" and nothing about what it changed over a decade. This keeps the
long record, one file per manager in data/funds/history/<id>.json, so the site
reads one small file for one manager rather than one large file for all of them.

What it shares with the snapshot
--------------------------------
Quarters are chosen, amended and attributed to their filer by the same three
functions sync_funds.py uses (quarter_filings, plan_quarters, read_quarter), so
a quarter reads the same here as on the manager's current page: restatements
replace, NEW HOLDINGS amendments add, and each quarter keeps the CIK and
accession that filed it, across a change of filer.

What each quarter carries
-------------------------
- the filing's provenance: filer CIK, accession, link, amendments applied, and
  `signature`, the accessions it was read from;
- the book: reported value, positions, top-ten share, concentration (HHI);
- what changed against the quarter immediately before, counted over the WHOLE
  book: new, added, trimmed, held and exited positions, the value of what was
  opened and closed, and an estimated turnover;
- the largest `KEEP` positions with their action, and the largest increases,
  reductions and exits. A manager with more positions than that has the rest
  counted but not listed, and the quarter says so (`listed`, `listedValuePct`).

A quarter is compared only with the quarter immediately before it on file. A
gap (a quarter the manager did not file) is never read as a hundred exits.

Incremental, and bounded
------------------------
A quarter already in the file is read again only when its signature changes,
which is what a new amendment does. A quarter that is (re)read also re-derives
the quarter after it, whose comparison depended on it. Each run reads at most
`--budget` quarters, newest managers' missing quarters first, so the first
backfill spreads over several runs and every later run reads roughly one
quarter per manager. A file whose backfill is unfinished says so (`complete`,
`pending`).

The floor is 2013-06-30. Earlier 13F tables are plain text inside the primary
document, which read_filing does not parse; a quarter it cannot read is listed
in `unreadable` rather than silently skipped.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sync_funds as sf  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "data" / "funds" / "history"
CUSIP_TICKERS = ROOT / "data" / "cusip-tickers.auto.json"

SCHEMA = 1
FLOOR = "2013-06-30"
KEEP = 500        # positions listed per quarter, largest first
MOVES = 15        # largest increases and reductions listed per quarter
EXITS = 25        # largest exits listed per quarter
DEFAULT_BUDGET = 600

ACTION_CODE = {"new": "n", "added": "a", "trimmed": "t", "held": "h"}


# ── what a quarter says, given the one before it (pure) ──────────────────────

def _key(p: dict) -> tuple[str, str]:
    return (p["cusip"], p["class"].upper())


def previous_quarter(q: str) -> str:
    y, n = sf.quarter_key(q)
    return f"{y - 1}Q4" if n == 1 else f"{y}Q{n - 1}"


def derive(cur: dict, prev: dict | None) -> dict:
    """
    The quarter's book and what changed, from two full tables.

    `cur` and `prev` are read_quarter() results with every position, not a
    capped list. `prev` is used only when it is the quarter immediately before
    and has a table; otherwise nothing is compared and every position is held.
    """
    holdings = cur["holdings"]
    total = sum(p["value"] for p in holdings)
    comparable = (
        prev is not None
        and prev.get("holdings")
        and holdings
        and prev["quarter"] == previous_quarter(cur["quarter"])
    )
    prev_by = {_key(p): p for p in prev["holdings"]} if comparable else {}

    counts = {"new": 0, "added": 0, "trimmed": 0, "held": 0, "exited": 0}
    opened = closed = bought = sold = 0.0
    rows, moves = [], []
    for p in holdings:
        before = prev_by.get(_key(p))
        if not comparable:
            action = "held"
        elif before is None:
            action = "new"
        else:
            action = sf.action_for(p["shares"], before["shares"])
        counts[action] += 1
        price = p["value"] / p["shares"] if p["shares"] else 0.0
        if action == "new":
            opened += p["value"]
            bought += p["value"]
        elif before is not None:
            d = p["shares"] - before["shares"]
            if d > 0:
                bought += d * price
            elif d < 0:
                sold += -d * price
            if d:
                moves.append((p, d, p["value"] - before["value"]))
        rows.append((p, action))

    exits = []
    if comparable:
        still = {p["cusip"] for p in holdings}
        gone: dict[str, dict] = {}
        for p in prev["holdings"]:
            if p["cusip"] in still:
                continue
            g = gone.setdefault(p["cusip"], {"cusip": p["cusip"], "issuer": p["issuer"], "value": 0.0, "shares": 0})
            g["value"] += p["value"]
            g["shares"] += p["shares"]
        counts["exited"] = len(gone)
        closed = sum(g["value"] for g in gone.values())
        sold += closed
        exits = sorted(gone.values(), key=lambda g: -g["value"])

    prev_total = sum(p["value"] for p in prev["holdings"]) if comparable else 0.0
    avg = (total + prev_total) / 2 if comparable else 0.0
    listed = holdings[:KEEP]
    increases = sorted((m for m in moves if m[1] > 0), key=lambda m: -m[2])[:MOVES]
    decreases = sorted((m for m in moves if m[1] < 0), key=lambda m: m[2])[:MOVES]

    def k(v: float) -> int:  # dollars to thousands, the unit every value is stored in
        return int(round(v / 1e3))

    return {
        "aumK": k(total),
        "positions": len(holdings),
        "top10Pct": round(sum(p["value"] for p in holdings[:10]) / total, 4) if total else None,
        "hhi": round(sum((p["value"] / total) ** 2 for p in holdings), 4) if total else None,
        "vsPrior": prev["quarter"] if comparable else None,
        "counts": counts if comparable else None,
        "openedK": k(opened) if comparable else None,
        "closedK": k(closed) if comparable else None,
        # Purchases and sales are estimated from share changes at quarter-end
        # prices, so turnover is the conventional min(bought, sold) over the
        # average book: an estimate, labelled as one where it is shown.
        "turnover": round(min(bought, sold) / avg, 4) if comparable and avg else None,
        "listed": len(listed),
        "listedValuePct": round(sum(p["value"] for p in listed) / total, 4) if total else None,
        "holdings": [
            [p["cusip"], p["class"], p["shares"], k(p["value"]), ACTION_CODE[a]]
            for p, a in rows[:KEEP]
        ],
        "increases": [[p["cusip"], p["class"], d, k(dv)] for p, d, dv in increases],
        "decreases": [[p["cusip"], p["class"], d, k(dv)] for p, d, dv in decreases],
        "exits": [[g["cusip"], g["shares"], k(g["value"])] for g in exits[:EXITS]],
    }


def quarter_record(got: dict, derived: dict, signature: list[str]) -> dict:
    """A read quarter's provenance beside what derive() said about it."""
    return {
        "quarter": got["quarter"],
        "periodOfReport": got["periodOfReport"],
        "filed": got["filed"],
        "cik": got["cik"],
        "accession": got["accession"],
        "filingUrl": got["filingUrl"],
        **({"amendedBy": got["amendedBy"]} if got.get("amendedBy") else {}),
        "signature": signature,
        **derived,
    }


def issuer_names(got: dict) -> dict[str, str]:
    """CUSIP to the issuer name this filing gives it."""
    out: dict[str, str] = {}
    for p in got["holdings"]:
        out.setdefault(p["cusip"], sf.title_case(p["issuer"]) if p["issuer"].isupper() else p["issuer"])
    return out


# ── a manager's file ─────────────────────────────────────────────────────────

TOP = 25          # positions in the index per quarter, and the rank that earns a position a series


def split(doc: dict) -> tuple[dict, dict[str, dict]]:
    """
    One manager's history as the files it is published in.

    index.json is what a page reads: every quarter's figures and its largest
    TOP positions and moves, plus a series for every position that was ever
    among the largest TOP, so the page draws the whole decade from one small
    file. <year>.json holds each quarter's full listed positions; a year that
    has ended is never rewritten, which keeps the repository's history small.
    """
    series: dict[str, list] = {}
    notable = {row[0] + "|" + row[1] for q in doc["quarters"] for row in q["holdings"][:TOP]}
    for q in sorted(doc["quarters"], key=lambda q: q["periodOfReport"]):
        for row in q["holdings"]:
            key = row[0] + "|" + row[1]
            if key in notable:
                series.setdefault(key, []).append([q["quarter"], row[2], row[3]])
    in_index = {k.split("|")[0] for k in series}
    in_index |= {r[0] for q in doc["quarters"] for key in ("increases", "decreases", "exits") for r in q[key]}
    index = {k: v for k, v in doc.items() if k not in ("quarters", "names")}
    index["top"] = TOP
    index["quarters"] = [{**{k: v for k, v in q.items() if k != "holdings"}, "top": q["holdings"][:TOP]}
                         for q in doc["quarters"]]
    index["series"] = series
    index["names"] = {c: n for c, n in doc["names"].items() if c in in_index}
    years: dict[str, dict] = {}
    for q in doc["quarters"]:
        y = q["quarter"][:4]
        yd = years.setdefault(y, {"schema": SCHEMA, "id": doc["id"], "year": y, "quarters": {}, "names": {}})
        yd["quarters"][q["quarter"]] = q["holdings"]
        for row in q["holdings"]:
            if row[0] in doc["names"]:
                yd["names"][row[0]] = doc["names"][row[0]]
    return index, years


def same_content(old: str, new: str) -> bool:
    """Equal apart from the run's own timestamp, so a run that changed nothing rewrites nothing."""
    try:
        a, b = json.loads(old), json.loads(new)
    except Exception:
        return False
    a.pop("generatedAt", None)
    b.pop("generatedAt", None)
    return a == b


def write_split(doc: dict, out: Path) -> int:
    """Write a manager's files, touching a year file only when its content changed. Returns bytes written."""
    index, years = split(doc)
    folder = out / doc["id"]
    folder.mkdir(parents=True, exist_ok=True)
    size = 0
    for name, body in [("index.json", index), *((f"{y}.json", d) for y, d in years.items())]:
        text = json.dumps(body, separators=(",", ":"), sort_keys=name != "index.json") + "\n"
        path = folder / name
        if path.exists() and same_content(path.read_text(), text):
            continue
        path.write_text(text)
        size += len(text)
    for stale in folder.glob("*.json"):
        if stale.name != "index.json" and stale.stem not in years:
            stale.unlink()
    return size


def load_existing(folder: Path) -> dict | None:
    """A manager's published files read back into one document, or None."""
    try:
        index = json.loads((folder / "index.json").read_text())
    except Exception:
        return None
    if index.get("schema") != SCHEMA:
        return None
    holdings: dict[str, list] = {}
    names: dict[str, str] = dict(index.get("names", {}))
    for path in folder.glob("[0-9][0-9][0-9][0-9].json"):
        try:
            yd = json.loads(path.read_text())
        except Exception:
            return None
        holdings.update(yd.get("quarters", {}))
        names.update(yd.get("names", {}))
    quarters = []
    for q in index["quarters"]:
        if q["quarter"] not in holdings:
            return None  # a year file is missing: rebuild rather than guess
        quarters.append({**{k: v for k, v in q.items() if k != "top"}, "holdings": holdings[q["quarter"]]})
    doc = {k: v for k, v in index.items() if k not in ("quarters", "series", "names", "top")}
    doc["quarters"] = quarters
    doc["names"] = names
    return doc


def plan_work(planned: list[dict], existing: dict | None) -> list[str]:
    """
    Which period ends must be read: missing or re-amended quarters, and the
    quarter after each, whose comparison depended on it. Oldest first.
    """
    have = {q["periodOfReport"]: q for q in (existing or {}).get("quarters", [])}
    periods = sorted(f["periodOfReport"] for f in planned)
    stale = {
        f["periodOfReport"] for f in planned
        if f["periodOfReport"] not in have
        or have[f["periodOfReport"]].get("signature") != sf.quarter_signature(f)
    }
    for i, p in enumerate(periods[:-1]):
        if p in stale:
            stale.add(periods[i + 1])
    return [p for p in periods if p in stale]


def build_history(entry: dict, sources: list[tuple[dict, dict]], *, since: str, budget: int,
                  existing: dict | None, use_cache: bool, stats: dict) -> tuple[dict | None, int]:
    """The manager's history document, and how many quarters this call read."""
    filings = [f for f in sf.quarter_filings(sources) if f["periodOfReport"] >= since]
    if not filings:
        return None, 0
    planned = sf.plan_quarters(filings, use_cache=use_cache, stats=stats)
    by_period = {f["periodOfReport"]: f for f in planned}
    todo = plan_work(planned, existing)

    kept = {q["periodOfReport"]: q for q in (existing or {}).get("quarters", [])
            if q["periodOfReport"] in by_period and q["periodOfReport"] not in todo}
    names: dict[str, str] = dict((existing or {}).get("names", {}))
    unreadable = set((existing or {}).get("unreadable", [])) - set(todo)

    read = 0
    tables: dict[str, dict] = {}
    pending: list[str] = []
    periods = sorted(by_period)

    def table(period: str) -> dict | None:
        nonlocal read
        if period in tables:
            return tables[period]
        got = sf.read_quarter(entry, by_period[period], use_cache=use_cache, stats=stats)
        read += 1
        tables[period] = got
        return got

    # Newest first, so an interrupted backfill always has the recent record.
    for period in sorted(todo, reverse=True):
        if read >= budget:
            pending.append(period)
            continue
        cur = table(period)
        if cur is None:
            unreadable.add(period)
            continue
        # The comparison needs the previous quarter's whole table, which the
        # file does not keep, so it is read again (from the cache, mostly).
        i = periods.index(period)
        prev = table(periods[i - 1]) if i > 0 else None
        names.update(issuer_names(cur))
        rec = quarter_record(cur, derive(cur, prev), sf.quarter_signature(by_period[period]))
        # Compared across a change of filer: say so, and whose holdings the new
        # filer's report also includes, so "new" is read with that in mind.
        if prev is not None and rec["vsPrior"] and prev.get("cik") != cur["cik"]:
            try:
                cover = sf.read_cover(cur["cik"], cur["accession"], use_cache=use_cache)
                rec["filerChange"] = {"fromCik": prev.get("cik"),
                                      "includedManagers": cover.get("otherManagers", [])}
            except Exception:
                rec["filerChange"] = {"fromCik": prev.get("cik"), "includedManagers": None}
        kept[period] = rec

    quarters = sorted(kept.values(), key=lambda q: q["periodOfReport"], reverse=True)
    if not quarters:
        return None, read
    listed = {row[0] for q in quarters for key in ("holdings", "increases", "decreases") for row in q[key]}
    listed |= {row[0] for q in quarters for row in q["exits"]}
    filers = sf.entry_filers(entry)
    doc = {
        "schema": SCHEMA,
        "id": entry.get("id") or sf.slugify(entry["name"]),
        "name": entry["name"],
        "cik": quarters[0]["cik"],
        **({"filers": [{k: f[k] for k in ("cik", "edgarName", "from", "to") if f.get(k)} for f in filers]}
           if len(filers) > 1 else {}),
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "since": since,
        "keep": KEEP,
        "complete": not pending,
        **({"pending": sorted(pending)} if pending else {}),
        **({"unreadable": sorted(unreadable)} if unreadable else {}),
        **({"notes": entry["notes"]} if entry.get("notes") else {}),
        "names": {c: n for c, n in sorted(names.items()) if c in listed},
        "quarters": quarters,
    }
    return doc, read


# ── the security register ────────────────────────────────────────────────────

def build_securities(docs: list[dict], tickers: dict[str, str]) -> dict:
    """
    Every security listed in any manager's history, by CUSIP.

    A CUSIP identifies one issue and keeps it through a renaming, so it is the
    key. The name is the latest a filer gave it, with every earlier name and
    the quarters it was used in. A ticker is given only where the SEC's own
    CUSIP-to-symbol data maps it (`tickerSource: "sec-ftd"`); that map is
    current, so the ticker is today's symbol, never claimed for past quarters.
    """
    seen: dict[str, dict] = {}
    for doc in docs:
        by_quarter = sorted(doc["quarters"], key=lambda q: q["periodOfReport"])
        for q in by_quarter:
            for row in q["holdings"]:
                cusip = row[0]
                name = doc["names"].get(cusip)
                s = seen.setdefault(cusip, {"names": {}, "firstSeen": q["quarter"], "lastSeen": q["quarter"],
                                            "managers": set()})
                s["firstSeen"] = min(s["firstSeen"], q["quarter"], key=sf.quarter_key)
                s["lastSeen"] = max(s["lastSeen"], q["quarter"], key=sf.quarter_key)
                s["managers"].add(doc["id"])
                if name:
                    span = s["names"].setdefault(name, [q["quarter"], q["quarter"]])
                    span[0] = min(span[0], q["quarter"], key=sf.quarter_key)
                    span[1] = max(span[1], q["quarter"], key=sf.quarter_key)
    out = {}
    for cusip, s in sorted(seen.items()):
        names = sorted(s["names"].items(), key=lambda kv: sf.quarter_key(kv[1][1]))
        rec = {
            "name": names[-1][0] if names else None,
            "firstSeen": s["firstSeen"],
            "lastSeen": s["lastSeen"],
            "managers": len(s["managers"]),
        }
        if len(names) > 1:
            rec["names"] = [{"name": n, "from": a, "to": b} for n, (a, b) in names]
        t = tickers.get(cusip)
        if t:
            rec["ticker"] = t
            rec["tickerSource"] = "sec-ftd"
        out[cusip] = rec
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manager", action="append", help="a CIK (any of the manager's filers); repeatable")
    ap.add_argument("--since", default=FLOOR, help=f"earliest period end (default {FLOOR})")
    ap.add_argument("--budget", type=int, default=DEFAULT_BUDGET, help="most quarters read this run")
    ap.add_argument("--full", action="store_true", help="ignore the on-disk filing cache")
    ap.add_argument("--out", type=Path, default=OUT_DIR, help="where the history files go")
    args = ap.parse_args()

    managers = sf.load_universe()["managers"]
    if args.manager:
        want = {c.zfill(10) for c in args.manager}
        managers = [m for m in managers if want & {f["cik"] for f in sf.entry_filers(m)}]
    problems = [msg for m in managers for msg in sf.filer_problems(m)]
    if problems:
        raise SystemExit("; ".join(problems))

    stats = {k: 0 for k in ("fetched", "cached", "filingErrors", "filingsEmpty", "amendmentsSkipped",
                            "amendmentsApplied", "amendmentsTreatedAsRestated")}
    stats.update({"totalMismatch": []})
    args.out.mkdir(parents=True, exist_ok=True)

    # Managers with the least history on disk go first, so a budget spent on a
    # backfill reaches everyone before deepening anyone.
    def depth(m: dict) -> int:
        doc = load_existing(args.out / (m.get("id") or sf.slugify(m["name"])))
        return len(doc["quarters"]) if doc else 0
    managers = sorted(managers, key=depth)

    budget = args.budget
    written = incomplete = 0
    for entry in managers:
        mid = entry.get("id") or sf.slugify(entry["name"])
        existing = load_existing(args.out / mid)
        if budget <= 0:
            incomplete += 1
            continue
        try:
            sources = [(f, sf.submissions(f["cik"], quarters=60)) for f in sf.entry_filers(entry)]
            doc, read = build_history(entry, sources, since=args.since, budget=budget, existing=existing,
                                      use_cache=not args.full, stats=stats)
        except Exception as e:
            print(f"{mid}: {type(e).__name__}: {e}")
            continue
        budget -= read
        if doc is None:
            print(f"{mid}: no readable quarters since {args.since}")
            continue
        size = write_split(doc, args.out)
        written += 1
        incomplete += 0 if doc["complete"] else 1
        q = doc["quarters"]
        left = f"  pending {len(doc['pending'])}" if not doc["complete"] else ""
        print(f"{mid:<40} {q[-1]['quarter']}..{q[0]['quarter']} {len(q):>3}q  read {read:>3}{left}"
              f"  index {(args.out / mid / 'index.json').stat().st_size / 1e3:,.0f} KB, wrote {size / 1e3:,.0f} KB")

    docs = [d for p in sorted(args.out.iterdir()) if p.is_dir() and (d := load_existing(p))]
    try:
        tickers = json.loads(CUSIP_TICKERS.read_text()).get("tickers", {})
    except Exception:
        tickers = {}
    register = build_securities(docs, tickers)
    # Beside the history directory: data/funds/securities.json for the default.
    securities = args.out.parent / "securities.json"
    securities.write_text(json.dumps({
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count": len(register),
        "securities": register,
    }, separators=(",", ":")) + "\n")

    print(f"\nwrote {written} manager histories · {incomplete} unfinished · securities {len(register):,}")
    print(f"filings fetched {stats['fetched']} · from cache {stats['cached']} · errors {stats['filingErrors']} · "
          f"amendments applied {stats['amendmentsApplied']} · treated as restated {stats['amendmentsTreatedAsRestated']}")
    for msg in stats["totalMismatch"]:
        print(f"  value total: {msg}")


if __name__ == "__main__":
    main()
