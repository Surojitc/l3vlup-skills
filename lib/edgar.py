"""
SEC EDGAR client — the only source of historic financials in this repo.

House rule, non-negotiable: **every historic financial figure comes from a filing.**
Not from an aggregator, not from a screener, not from a model's memory. XBRL
company facts are the filer's own tagged numbers as submitted, so each value here
carries the tag, the period, the form, the accession number and a link back to the
filing index on EDGAR. If a line item cannot be found in the filings, this module
returns None — it never substitutes, estimates or interpolates.

Forward numbers (consensus, guidance, your own projections) are a different animal
and are never mixed into these functions. They belong in an Estimates block, shaded,
labelled E, and sourced separately.

No API key. EDGAR asks only for a descriptive User-Agent with a contact address:
https://www.sec.gov/os/accessing-edgar-data
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from functools import lru_cache

from .banker_xlsx import Fact, Source

UA = os.environ.get("SEC_USER_AGENT", "L3VLUP open skills contact@l3vlup.com")
BASE_DATA = "https://data.sec.gov"
BASE_WWW = "https://www.sec.gov"

# EDGAR asks for no more than 10 requests/second. We sit well under it.
_MIN_INTERVAL = 0.15
_last_call = 0.0


def _get(url: str, *, retries: int = 4) -> dict:
    global _last_call
    for attempt in range(retries):
        wait = _MIN_INTERVAL - (time.time() - _last_call)
        if wait > 0:
            time.sleep(wait)
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept-Encoding": "gzip, deflate",
            "Accept": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    import gzip
                    raw = gzip.decompress(raw)
                _last_call = time.time()
                return json.loads(raw)
        except urllib.error.HTTPError as e:
            _last_call = time.time()
            if e.code == 404:
                raise FileNotFoundError(url) from e
            if e.code in (403, 429) and attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            _last_call = time.time()
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)
    raise RuntimeError(f"unreachable: {url}")


@lru_cache(maxsize=1)
def _ticker_map() -> dict[str, str]:
    data = _get(f"{BASE_WWW}/files/company_tickers.json")
    return {row["ticker"].upper(): str(row["cik_str"]).zfill(10) for row in data.values()}


def cik_for(ticker: str) -> str:
    """Zero-padded 10-digit CIK for a US-listed ticker."""
    cik = _ticker_map().get(ticker.upper())
    if not cik:
        raise KeyError(f"{ticker} is not in the SEC ticker file — foreign private issuers "
                       f"filing 20-F may be listed under a different symbol")
    return cik


@lru_cache(maxsize=64)
def company_facts(cik: str) -> dict:
    return _get(f"{BASE_DATA}/api/xbrl/companyfacts/CIK{cik}.json")


@lru_cache(maxsize=64)
def submissions(cik: str) -> dict:
    return _get(f"{BASE_DATA}/submissions/CIK{cik}.json")


def filing_url(cik: str, accession: str) -> str:
    """Link to the filing index page — stable for every accession."""
    return (f"{BASE_WWW}/Archives/edgar/data/{int(cik)}/"
            f"{accession.replace('-', '')}/{accession}-index.htm")


@dataclass(frozen=True)
class Observation:
    """One XBRL fact as the filer tagged it."""

    tag: str
    taxonomy: str
    unit: str
    value: float
    start: str | None
    end: str
    fy: int | None
    fp: str | None
    form: str
    filed: str
    accession: str
    frame: str | None

    @property
    def period_label(self) -> str:
        if self.fp == "FY" and self.fy:
            return f"FY{self.fy}"
        if self.fy and self.fp:
            return f"{self.fp}{str(self.fy)[2:]}"
        return self.end

    def source(self, ticker: str, cik: str, label: str | None = None) -> Source:
        return Source(
            label=f"{ticker} {label or self.period_label} {self.form}",
            detail=f"{self.taxonomy}:{self.tag} · period ending {self.end} · "
                   f"{self.unit} · filed {self.filed}",
            url=filing_url(cik, self.accession),
            accession=self.accession,
        )


ANNUAL_FORMS = ("10-K", "10-K/A", "20-F", "40-F")
QUARTERLY_FORMS = ("10-Q", "10-Q/A")


def observations(facts: dict, tag: str, *, unit_kind: str = "USD") -> list[Observation]:
    """All observations for one tag, newest last. Tries us-gaap then ifrs-full then dei."""
    out: list[Observation] = []
    for taxonomy in ("us-gaap", "ifrs-full", "dei", "srt"):
        node = facts.get("facts", {}).get(taxonomy, {}).get(tag)
        if not node:
            continue
        for unit, rows in node.get("units", {}).items():
            if unit_kind == "USD" and unit != "USD":
                continue
            if unit_kind == "shares" and unit != "shares":
                continue
            if unit_kind == "USD/shares" and unit != "USD/shares":
                continue
            for row in rows:
                if row.get("val") is None or not isinstance(row["val"], (int, float)):
                    continue
                out.append(Observation(
                    tag=tag, taxonomy=taxonomy, unit=unit, value=float(row["val"]),
                    start=row.get("start"), end=row["end"], fy=row.get("fy"),
                    fp=row.get("fp"), form=row.get("form", ""), filed=row.get("filed", ""),
                    accession=row.get("accn", ""), frame=row.get("frame"),
                ))
        if out:
            break
    out.sort(key=lambda o: (o.end, o.filed))
    return out


def _duration_days(o: Observation) -> int | None:
    if not o.start:
        return None
    from datetime import date
    a = date.fromisoformat(o.start)
    b = date.fromisoformat(o.end)
    return (b - a).days


def _fy_label(obs_at_end: list[Observation], end: str) -> str:
    """
    The filer's own name for this fiscal year.

    XBRL `fy`/`fp` describe the FILING's fiscal year, not the period's. A FY2025
    10-K carries FY2023, FY2024 and FY2025 all tagged fy=2025 — keying on `fy`
    shifts every comparative forward and silently mislabels the whole sheet.

    So: take `fy` only from an observation filed shortly AFTER the period it
    covers, which is the original annual report for that year rather than a later
    filing's comparative. Where no such observation exists, fall back to the
    calendar year of the period end, which is right for every fiscal year ending
    after March.
    """
    from datetime import date

    e = date.fromisoformat(end)
    best: tuple[int, int] | None = None
    for o in obs_at_end:
        if o.fp != "FY" or not o.fy or not o.filed:
            continue
        try:
            gap = (date.fromisoformat(o.filed) - e).days
        except ValueError:
            continue
        if 0 <= gap <= 150 and (best is None or gap < best[0]):
            best = (gap, o.fy)
    if best:
        return f"FY{best[1]}"
    # A fiscal year ending in January or February is named for the prior calendar
    # year by most filers who do it; anything later takes the end year.
    return f"FY{e.year - 1 if e.month <= 2 else e.year}"


def _by_end(obs: list[Observation], flow: bool) -> dict[str, Observation]:
    if flow:
        obs = [o for o in obs if (d := _duration_days(o)) and 340 <= d <= 400]
    else:
        obs = [o for o in obs if o.start is None or (_duration_days(o) or 0) <= 1]
    out: dict[str, Observation] = {}
    for o in obs:
        keep = out.get(o.end)
        if keep is None or (o.filed or "9999") < (keep.filed or "9999"):
            out[o.end] = o
    return out


def annual_series(facts: dict, tags: list[str], *, unit_kind: str = "USD",
                  flow: bool = True, years: int = 6) -> dict[str, Observation]:
    """
    Fiscal-year observations keyed by PERIOD END DATE.

    Keyed by end date rather than fiscal year because the end date is a fact and
    the fiscal year is a label. Flow items (revenue, cash flow) must span a full
    year; stock items (balance sheet) are point-in-time.

    **Tag choice is by coverage, not by order.** Filers switch tags: NVIDIA
    reported revenue under one concept for years and then moved to another, and a
    naive first-match returns the abandoned tag with its stale history — the sheet
    then quietly shows a company as it was four years ago. So every tag in the
    preference list is evaluated, and the one reaching the most recent period
    wins, with the number of periods and then list order as tie-breaks.

    Where the same period appears in several filings, the ORIGINAL filing wins
    over a later restatement's comparative — an analyst reading a FY2023 number
    wants the number as reported for FY2023. Restatements stay visible because the
    accession on the Sources tab names the filing.
    """
    best: tuple[str, int, int] | None = None
    best_map: dict[str, Observation] = {}
    for rank, tag in enumerate(tags):
        obs = [o for o in observations(facts, tag, unit_kind=unit_kind)
               if o.form in ANNUAL_FORMS]
        by_end = _by_end(obs, flow)
        if not by_end:
            continue
        score = (max(by_end), len(by_end), -rank)
        if best is None or score > best:
            best, best_map = score, by_end
    return dict(sorted(best_map.items())[-years:]) if best_map else {}


def fiscal_labels(facts: dict, ends: list[str]) -> dict[str, str]:
    """Resolve each period end to the filer's own fiscal-year name."""
    pool: dict[str, list[Observation]] = {e: [] for e in ends}
    for tag in ("Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax",
                "Assets", "NetIncomeLoss", "StockholdersEquity"):
        for o in observations(facts, tag):
            if o.end in pool:
                pool[o.end].append(o)
    return {e: _fy_label(pool[e], e) for e in ends}


def quarterly_series(facts: dict, tags: list[str], *, unit_kind: str = "USD",
                     flow: bool = True, quarters: int = 8) -> list[Observation]:
    """Most recent N quarterly observations, oldest first. Tag chosen by coverage."""
    best: tuple[str, int, int] | None = None
    best_map: dict[str, Observation] = {}
    for rank, tag in enumerate(tags):
        obs = [o for o in observations(facts, tag, unit_kind=unit_kind)
               if o.form in QUARTERLY_FORMS or o.form in ANNUAL_FORMS]
        if flow:
            obs = [o for o in obs if (d := _duration_days(o)) and 80 <= d <= 100]
        else:
            obs = [o for o in obs if o.start is None or (_duration_days(o) or 0) <= 1]
        by_end: dict[str, Observation] = {}
        for o in obs:
            keep = by_end.get(o.end)
            if keep is None or (o.filed or "9999") < (keep.filed or "9999"):
                by_end[o.end] = o
        if not by_end:
            continue
        score = (max(by_end), len(by_end), -rank)
        if best is None or score > best:
            best, best_map = score, by_end
    return sorted(best_map.values(), key=lambda o: o.end)[-quarters:]


def to_facts(ticker: str, cik: str, series: dict[str, Observation],
             ends: list[str], labels: dict[str, str] | None = None) -> list[Fact]:
    """Align a series onto the period-end axis, carrying provenance."""
    out = []
    for e in ends:
        o = series.get(e)
        out.append(Fact(o.value, o.source(ticker, cik, (labels or {}).get(e)))
                   if o else Fact(None))
    return out


def company_name(facts: dict) -> str:
    return facts.get("entityName", "").strip()


def latest_filings(cik: str, forms: tuple[str, ...] = ANNUAL_FORMS + QUARTERLY_FORMS,
                   limit: int = 10) -> list[dict]:
    """Recent filings with form, date, accession and index URL."""
    recent = submissions(cik).get("filings", {}).get("recent", {})
    rows = []
    for i, form in enumerate(recent.get("form", [])):
        if form not in forms:
            continue
        accn = recent["accessionNumber"][i]
        rows.append({
            "form": form,
            "filed": recent["filingDate"][i],
            "period": recent.get("reportDate", [None] * (i + 1))[i],
            "accession": accn,
            "url": filing_url(cik, accn),
            "primary": recent.get("primaryDocument", [""] * (i + 1))[i],
        })
        if len(rows) >= limit:
            break
    return rows
