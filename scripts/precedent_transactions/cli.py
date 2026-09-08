"""The subcommands, and what each of them costs to run."""

from __future__ import annotations

import argparse

from . import database, formindex, takeprivates

DESCRIPTION = """\
Build data/precedent-transactions.auto.json from SEC filings.

Two subcommands, writing to one file. Each refreshes only the rows it wrote, so
they can be run in either order and on different schedules.

  precedents  the take-privates listed in data/decks.auto.json (Schedule 13E-3
              since 2020, which scripts/sync-decks.mjs collects). Reads the
              transaction statement, its (a) exhibits and the target's own
              proxy for the price, the premiums and the agreement date, then
              the target's XBRL facts at announcement.

  mergers     the deals that index cannot see: DEFM14A and DEFM14C definitive
              merger proxies, and Schedule 13E-3 statements filed before 2020,
              found through EDGAR's quarterly form index. The index itself is
              cached per quarter in data/merger-index.auto.json; a closed
              quarter is downloaded once and never again.

Both are incremental. A row already on file is kept, and a deal whose filing
stated no per-share price is remembered as such so it is not read again on
every run. The first run of `mergers` from an empty database is thousands of
requests and several hours; a steady-state run is one quarterly index plus a
handful of requests per genuinely new filing.

Every source is a public SEC endpoint. No key, no account, no secret.
Set SEC_USER_AGENT to the contact address EDGAR should see.

  python3 scripts/sync_precedent_transactions.py precedents
  python3 scripts/sync_precedent_transactions.py mergers --limit 5
  python3 scripts/sync_precedent_transactions.py mergers --since 2016 --forms 'SC 13E3'
  python3 scripts/sync_precedent_transactions.py mergers --only 0001193125-24-123456
"""


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="sync_precedent_transactions.py",
        description=DESCRIPTION,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subs = ap.add_subparsers(dest="command", required=True)

    tp = subs.add_parser("precedents", help="take-privates from data/decks.auto.json")
    tp.add_argument("--limit", type=int, help="read at most N deals not yet in the database")
    tp.add_argument("--only", help="read one deal by its accession number, replacing its row")
    tp.add_argument("--full", action="store_true", help="read every take-private again, including those that gave no offer price")

    mg = subs.add_parser("mergers", help="public mergers and pre-2020 take-privates from the quarterly form index")
    mg.add_argument("--limit", type=int, help="read at most N filings not yet in the database")
    mg.add_argument("--only", help="read one filing by its accession number, replacing its row")
    mg.add_argument("--full", action="store_true", help="read every filing of that universe again")
    mg.add_argument("--since", type=int, default=2020, help="the first year of filings to index (default 2020)")
    mg.add_argument("--forms", help=f"which indexed form types to read this pass, comma separated (default all: {','.join(formindex.FORMS)})")

    args = ap.parse_args(argv)

    if args.command == "precedents":
        out = takeprivates.build(limit=args.limit, only=args.only, full=args.full)
        print(f"{database.OUT} ({out['counts']['transactions']} transactions)")
        return 0

    forms = tuple(f.strip() for f in args.forms.split(",")) if args.forms else formindex.FORMS
    unknown = [f for f in forms if f not in formindex.FORMS]
    if unknown:
        raise SystemExit(f"Not an indexed form type: {', '.join(unknown)}. Known: {', '.join(formindex.FORMS)}.")
    out = formindex.build(limit=args.limit, since=args.since, only=args.only, full=args.full, forms=forms)
    c = out["counts"]
    print(f"{database.OUT} ({c['transactions']} transactions: {c['takePrivates']} take-privates, {c['publicMergers']} public mergers)")
    return 0
