"""
What a run may not do to the observations already on file.

The database accumulates: a deal read in 2021 is not read again in 2026
unless a reader changes. So a run that fails to read a filing, an EDGAR outage,
or a parser change that drops a figure it used to find, would otherwise
overwrite a good, sourced observation with a worse one, and the publication
gate (which counts rows) would not notice. This module is the line between the
two, applied on every write so that a run cut short leaves a checked file too.

Against the file as it stood when the run began (the baseline):

  - a row that disappears, or that a re-read turns into status "error", is put
    back as it was, and the run logs it for review;
  - a sourced field that goes from a value to nothing is put back, unless the
    reader that owns the field moved forward on that row in this run (a
    premiumReader or financialsReader bump: a correction that withdraws a
    figure on purpose, such as an adviser's range read as a premium or an
    EBITDA whose parts were for different twelve months), the row's target
    changed (it was read for the wrong company), or the row was reclassified
    (rejected, duplicate, a different deal type);
  - every change to a sourced field, kept or withdrawn, is recorded on the row
    under `revisions` with the run, the old value, the new one and the cause,
    so a published figure can always be traced back to what it replaced.

And once per write, a run-level check: if any sourced field is withdrawn, after
the protection above, from more than MAX_FIELD_LOSS of the rows that carried it
and from at least MIN_LOST rows, the write is refused. The file on
disk stays as the last write that passed, the report goes to the run log and to
a file outside the repository (`$RUNNER_TEMP` or the system temp directory), and
the run stops with GuardRefused. Nothing inside the checkout is written, because
the collect job stages every changed file and a stray report would block the
whole publication rather than just this one.

The thresholds were set against the first run of the merged readers over the
published database (October 2026): one-day premiums lost 48 of 1,724 (2.8%),
EBITDA 27 of 1,978 (1.4%), and three small fields crossed 5% on a handful of
rows (30-day VWAP 18 of 298, 52-week high 3 of 58, LTM EBIT 14 of 163). A share
alone would have refused that run over 3 rows, so a refusal needs both: more
than 5% and at least 25 rows. A reader that loses one figure in ten of any
field carried by 250 rows or more is stopped.
"""

from __future__ import annotations

import copy
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

#: the most a single field may lose, as a share of the rows that carried it, in one run
MAX_FIELD_LOSS = 0.05
#: and the fewest rows a field must lose before the share is judged at all
MIN_LOST = 25
#: the most revisions kept on one row, newest last
MAX_REVISIONS = 20

#: the figures read from a filing or the company facts, and the reader version that owns each.
#: The acquirer is not among them: it is a label, not a figure, and its reader
#: withdraws merger vehicles and fragments ("Wolverine Merger Corporation",
#: "Inc.") with no version to say so, so guarding it would keep the worse name.
SOURCED: dict[str, str | None] = {
    "offerPrice": None,
    "consideration": None,
    "dealValue": None,
    "premium1Day": "premiumReader",
    "premium30DayVwap": "premiumReader",
    "premium52WeekHigh": "premiumReader",
    "unaffectedPriceStated": "premiumReader",
    "unaffectedDate": "premiumReader",
    "premiumPreAnnouncement": "premiumReader",
    "sharesOut": "financialsReader",
    "ltmRevenue": "financialsReader",
    "ltmEbitda": "financialsReader",
    "ltmEbit": "financialsReader",
    "netDebt": "financialsReader",
}

#: statuses a row can be moved to on purpose by a classification, after which its figures no longer count
SET_ASIDE = ("rejected", "duplicate", "no-consideration")


class GuardRefused(RuntimeError):
    """A write that would withdraw too many sourced figures at once."""


#: one stamp per process, so the repeated writes of a run record one revision per field, not one per write
RUN_AT = datetime.now(timezone.utc).replace(microsecond=0, tzinfo=None).isoformat() + "Z"


def _empty(v) -> bool:
    return v is None or v == "" or v == []


def _advanced(prev: dict, cur: dict, reader: str | None) -> bool:
    return bool(reader) and (cur.get(reader) or 1) > (prev.get(reader) or 1)


def _target(row: dict) -> str:
    return str(((row.get("target") or {}).get("cik")) or "").lstrip("0")


def _reclassified(prev: dict, cur: dict) -> bool:
    return (cur.get("status") in SET_ASIDE and prev.get("status") not in SET_ASIDE) or (cur.get("dealType") != prev.get("dealType"))


def _cause(prev: dict, cur: dict, reader: str | None) -> str | None:
    """Why a sourced field may have changed on purpose, or None."""
    if _advanced(prev, cur, reader):
        return f"{reader} {prev.get(reader) or 1} to {cur.get(reader)}"
    if _target(prev) != _target(cur):
        return "target re-identified"
    if _reclassified(prev, cur):
        return f"reclassified {prev.get('status')}/{prev.get('dealType')} to {cur.get('status')}/{cur.get('dealType')}"
    return None


def _revise(row: dict, field: str, before, after, cause: str) -> None:
    revs = [r for r in (row.get("revisions") or []) if not (r.get("run") == RUN_AT and r.get("field") == field)]
    revs.append({"run": RUN_AT, "field": field, "from": before, "to": after, "cause": cause})
    row["revisions"] = revs[-MAX_REVISIONS:]


def protect(baseline: dict[str, dict], rows: dict[str, dict]) -> dict:
    """
    Put back what this run lost without a reason, record what it changed, and
    return the report. `rows` is changed in place.
    """
    report = {"run": RUN_AT, "restoredRows": [], "keptPrior": [], "revised": 0}
    for rid, prev in baseline.items():
        cur = rows.get(rid)
        if cur is None:
            rows[rid] = copy.deepcopy(prev)
            report["restoredRows"].append({"id": rid, "why": "row missing from this run"})
            continue
        if cur.get("status") == "error" and prev.get("status") != "error":
            kept = copy.deepcopy(prev)
            kept.setdefault("readErrors", [])
            kept["readErrors"] = (kept["readErrors"] + [f"{RUN_AT}: re-read failed, prior reading kept: {str(cur.get('error') or '')[:100]}"])[-10:]
            rows[rid] = kept
            report["restoredRows"].append({"id": rid, "why": f"re-read ended in error: {str(cur.get('error') or '')[:100]}"})
            continue
        for field, reader in SOURCED.items():
            before, after = prev.get(field), cur.get(field)
            if before == after:
                continue
            cause = _cause(prev, cur, reader)
            if _empty(after) and not _empty(before) and cause is None:
                cur[field] = copy.deepcopy(before)
                report["keptPrior"].append({"id": rid, "field": field, "value": before})
                continue
            if _empty(before) and _empty(after):
                continue
            _revise(cur, field, before, after, cause or "read again")
            report["revised"] += 1
    return report


def losses(baseline: dict[str, dict], rows: dict[str, dict]) -> dict[str, dict]:
    """Per sourced field: how many rows carried it before, and how many of those are left without it."""
    out: dict[str, dict] = {}
    for field in SOURCED:
        carried = [rid for rid, r in baseline.items() if not _empty(r.get(field)) and r.get("status") not in SET_ASIDE]
        lost = [rid for rid in carried if rid in rows and _empty(rows[rid].get(field)) and rows[rid].get("status") not in SET_ASIDE]
        out[field] = {"carried": len(carried), "lost": len(lost), "share": (len(lost) / len(carried)) if carried else 0.0, "examples": lost[:10]}
    return out


def check(baseline: dict[str, dict], rows: dict[str, dict], report: dict) -> None:
    """Refuse the write when a field loses more than MAX_FIELD_LOSS of the rows that carried it."""
    loss = losses(baseline, rows)
    report["losses"] = {f: {k: v for k, v in d.items() if k != "examples"} for f, d in loss.items() if d["lost"]}
    over = {f: d for f, d in loss.items() if d["lost"] >= MIN_LOST and d["share"] > MAX_FIELD_LOSS}
    if report["restoredRows"] or report["keptPrior"]:
        print(f"guard: {len(report['restoredRows'])} rows and {len(report['keptPrior'])} fields kept as they were before this run (re-read failed or a figure was lost without a reader change)", file=sys.stderr, flush=True)
    if not over:
        return
    report["refused"] = {f: d for f, d in over.items()}
    where = Path(os.environ.get("RUNNER_TEMP") or tempfile.gettempdir()) / "precedent-transactions.guard.json"
    try:
        where.write_text(json.dumps(report, indent=1, default=str) + "\n")
    except OSError:
        where = None
    lines = "; ".join(f"{f}: {d['lost']} of {d['carried']} ({d['share']:.1%}), e.g. {', '.join(d['examples'][:3])}" for f, d in over.items())
    msg = f"guard: refused to write, more than {MAX_FIELD_LOSS:.0%} (and at least {MIN_LOST}) of the rows carrying a field would lose it: {lines}. The file keeps its last checked state." + (f" Report: {where}" if where else "")
    print(msg, file=sys.stderr, flush=True)
    raise GuardRefused(msg)
