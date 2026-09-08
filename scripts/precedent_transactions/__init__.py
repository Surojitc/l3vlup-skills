"""
The precedent transactions database, built from the filings themselves.

A precedent set is a claim that these deals tell you something about this one,
and the hardest question in the room is which row you would drop. Answering it
needs the filing's own numbers, not a vendor's summary. This collector reads
them out of the documents:

  announced      the merger agreement date, parsed from the transaction
                 statement ("Agreement and Plan of Merger, dated as of ...")
  offerPrice     the per-share cash consideration, from the same document, or
                 from the proxy attached to it where the statement is a short
                 wrapper around one
  premiums       the premiums the filing states itself, to the close before
                 announcement, the 30-day VWAP and the 52-week high, from which
                 the unaffected price and the other bases follow
  shares, LTM    the target's XBRL company facts as they stood at announcement:
                 the cover-page share count, the last twelve months to the last
                 period end before the deal, and net debt from that balance
                 sheet

Equity value, enterprise value and the multiples are arithmetic on those.

Two universes, both public and both needing no credential:

  take-privates   Schedule 13E-3 transaction statements. The recent ones are
                  listed in data/decks.auto.json, which sync-decks.mjs already
                  builds and commits; the older ones come from the form index
                  below, because that index only reaches back to 2020.
  public mergers  DEFM14A and DEFM14C definitive merger proxies, found through
                  EDGAR's quarterly form index. A 13E-3 is only filed when an
                  affiliate sits on the buy side, so without these the database
                  would skew small, recent and often distressed, and would leave
                  out the strategic deals a sector banker actually cites.

Every row carries `source` (the form it was read from) and `dealType`
("take-private" or "public merger"), so a reader can prefer one universe and
still fall back to the other where a set would be too thin to say anything.

The output is data/precedent-transactions.auto.json. It is incremental: a row
already on file is kept, a deal whose filing yields no offer price is
remembered as such so it is not read again on every run, and --full starts the
universe over.

    python3 scripts/sync_precedent_transactions.py --help

This is a straight port of skills/deal-slides/lib/{precedents,mergers}.py from
the private site repository, which is where the same JSON is read and rendered.
The slide kit's own reading and selection helpers stayed behind: nothing here
draws a page, so nothing here needs them.
"""

from .database import OUT, finalize, load_stored, write
from .formindex import FORMS
from .formindex import build as build_from_form_index
from .takeprivates import build as build_take_privates

__all__ = ["OUT", "FORMS", "build_take_privates", "build_from_form_index", "finalize", "load_stored", "write"]
