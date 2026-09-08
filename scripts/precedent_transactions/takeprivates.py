"""
The take-privates already listed in data/decks.auto.json.

sync-decks.mjs indexes every US Schedule 13E-3 since 2020 for the board-book
pages: the target with its CIK and industry code, the buyer group, the advisers
and the filing-fee value. It carries no offer price and no multiples, because
those are not on the cover of the statement; they are inside the document.

This builder reads the document. For each deal it takes the transaction
statement, its (a) exhibits and the target's own proxy, and reads the agreement
date, the price, the premiums and the share count out of them, then the
target's XBRL facts at announcement. The fee-table value from the index is kept
beside the derived equity value as a cross-check, because it is the filer's own
aggregate and the two should agree within reason.

Deals older than 2020 are not in this index at all. They come from the form
index instead, in formindex.py.
"""

from __future__ import annotations

import json
import os
import sys
import traceback

from . import database, filings


def build_row(tx: dict) -> dict:
    """One precedent row from one deck-index entry; `finalize` derives the values."""
    target = tx["target"]
    cik = target["cik"]
    row: dict = {
        "id": tx["id"],
        "target": {"name": target.get("name"), "cik": cik, "sic": target.get("sic"), "sicDescription": target.get("sicDescription"), "state": target.get("state")},
        "sector": tx.get("sector"),
        "buyers": tx.get("buyers") or [],
        "buyerType": tx.get("buyerType"),
        "advisers": tx.get("advisers") or [],
        "dealValue": tx.get("transactionValue"),
        "filed": tx["filings"][0]["filed"],
        "filingUrl": tx["filings"][0]["filingUrl"],
        "announced": tx["filings"][0]["filed"],
        "announcedBasis": "filing date",
        "offerPrice": None,
        "offerBasis": None,
        "consideration": "cash",
        "premium1Day": None,
        "premium30DayVwap": None,
        "premium52WeekHigh": None,
        "premiumBasis": [],
        "documentsRead": [],
        "readErrors": [],
        "status": "ok",
    }
    sub = filings.submissions(cik)
    docs = filings.docs_for(tx, sub)
    if docs:
        row["primaryDocUrl"] = docs[0]["url"]
    return filings.read_documents(row, docs)


def build(limit: int | None = None, only: str | None = None, full: bool = False) -> dict:
    """Read the deck index, add or refresh rows, write the database and return it."""
    if not database.DECKS.exists():
        raise SystemExit(f"{database.DECKS} not found; run scripts/sync-decks.mjs first.")
    index = json.loads(database.DECKS.read_text())
    txs = index.get("transactions") or []
    stored = database.load_stored()
    # Only the 13E-3 rows are this builder's to refresh: --full re-reads those
    # and leaves the merger proxies formindex.py wrote exactly where they are.
    owned = {k: v for k, v in stored.items() if (v.get("source") or "SC 13E3") == "SC 13E3"}
    existing: dict[str, dict] = {} if full else owned
    todo = [t for t in txs if (only and t["id"] == only) or (not only and t["id"] not in existing)]
    if only and not todo:
        raise SystemExit(f"{only} is not in the deck index.")
    if limit:
        todo = todo[:limit]
    print(f"{len(txs)} transactions in the index, {len(owned)} already in the database, {len(todo)} to read", file=sys.stderr)
    # --full with --only means "read that one again", not "start the universe
    # over", so the other rows stay where they are.
    rows = {k: v for k, v in stored.items() if k not in owned} if (full and not only) else dict(stored)
    for i, tx in enumerate(todo, 1):
        try:
            row = database.finalize(build_row(tx))
        except KeyboardInterrupt:
            raise
        except Exception as e:  # noqa: BLE001
            row = {"id": tx["id"], "target": tx["target"], "sector": tx.get("sector"), "announced": tx["filings"][0]["filed"], "announcedBasis": "filing date", "filingUrl": tx["filings"][0]["filingUrl"], "dealValue": tx.get("transactionValue"), "status": "error", "error": f"{type(e).__name__}: {str(e)[:120]}", "flags": []}
            if os.environ.get("PRECEDENTS_DEBUG"):
                traceback.print_exc()
        rows[row["id"]] = row
        print(f"[{i}/{len(todo)}] {database.line(row)}", file=sys.stderr, flush=True)
        # Write as it goes, so a run cut short keeps what it read.
        if i % 10 == 0:
            database.write(rows)
    out = database.write(rows)
    c = out["counts"]
    print(f"\n{c['transactions']} transactions: {c['withOffer']} with an offer price, {c['withMultiples']} with EV / LTM EBITDA, {c['withPremium']} with a stated premium, {c['flagged']} flagged for checking, {c['noOffer']} with no offer found, {c['errors']} errors.", file=sys.stderr)
    return out
