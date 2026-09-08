#!/usr/bin/env python3
"""
Precedent transactions from SEC filings, into data/precedent-transactions.auto.json.

The collector itself lives in scripts/precedent_transactions/, a module per
concern: what a filing says (parse), how EDGAR is read (filings), what the file
holds (database), and the two universes that fill it (takeprivates, formindex).
This is only the way in.

    python3 scripts/sync_precedent_transactions.py --help
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from precedent_transactions.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
