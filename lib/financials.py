"""
Statement assembly — filings in, aligned and sourced line items out.

This is the layer the skills call. It hides the tag-preference mess in lineitems.py
and the XBRL plumbing in edgar.py, and hands back a Statements object where every
value is a Fact carrying the filing it came from.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from . import edgar, lineitems as L
from .banker_xlsx import Fact


@dataclass
class Statements:
    ticker: str
    cik: str
    name: str
    years: list[int]
    rows: dict[str, list[Fact]] = field(default_factory=dict)
    quarters: list[str] = field(default_factory=list)
    q_rows: dict[str, list[Fact]] = field(default_factory=dict)
    missing: list[str] = field(default_factory=list)

    def annual(self, key: str) -> list[Fact]:
        return self.rows.get(key, [Fact(None) for _ in self.years])

    def quarterly(self, key: str) -> list[Fact]:
        return self.q_rows.get(key, [Fact(None) for _ in self.quarters])

    def latest(self, key: str) -> Fact:
        vals = [f for f in self.annual(key) if f.value is not None]
        return vals[-1] if vals else Fact(None)

    @property
    def period_labels(self) -> list[tuple[str, bool]]:
        return [(f"FY{y}", False) for y in self.years]


ALL_KEYS = {**L.INCOME, **L.BALANCE, **L.CASHFLOW}


def load(ticker: str, *, years: int = 5, quarters: int = 0,
         keys: list[str] | None = None) -> Statements:
    """
    Pull `years` fiscal years (and optionally `quarters` quarters) of filing data.

    Only keys present in the filings come back populated. Anything the filer did
    not tag is listed in `.missing` so the caller can say so on the face of the
    workbook rather than quietly printing a blank.
    """
    cik = edgar.cik_for(ticker)
    facts = edgar.company_facts(cik)
    name = edgar.company_name(facts) or ticker

    wanted = keys or list(ALL_KEYS)
    annual: dict[str, dict[int, edgar.Observation]] = {}
    for key in wanted:
        tags = ALL_KEYS.get(key)
        if not tags:
            continue
        annual[key] = edgar.annual_series(
            facts, tags, unit_kind=L.unit_kind_for(key), flow=L.is_flow(key), years=years,
        )

    # The year axis is whatever revenue reports; revenue is the one line every
    # operating filer tags. Fall back to the union if a filer is exotic.
    axis = sorted(annual.get("revenue", {}))
    if not axis:
        seen: set[int] = set()
        for s in annual.values():
            seen |= set(s)
        axis = sorted(seen)[-years:]
    axis = axis[-years:]

    st = Statements(ticker=ticker.upper(), cik=cik, name=name, years=axis)
    for key, series in annual.items():
        st.rows[key] = edgar.to_facts(st.ticker, cik, series, axis)
        if not series:
            st.missing.append(key)

    if quarters:
        q_obs: dict[str, list[edgar.Observation]] = {}
        for key in wanted:
            tags = ALL_KEYS.get(key)
            if not tags:
                continue
            q_obs[key] = edgar.quarterly_series(
                facts, tags, unit_kind=L.unit_kind_for(key),
                flow=L.is_flow(key), quarters=quarters,
            )
        ends = sorted({o.end for o in q_obs.get("revenue", [])})[-quarters:]
        if not ends:
            allends: set[str] = set()
            for obs in q_obs.values():
                allends |= {o.end for o in obs}
            ends = sorted(allends)[-quarters:]
        st.quarters = ends
        for key, obs in q_obs.items():
            by_end = {o.end: o for o in obs}
            st.q_rows[key] = [
                Fact(by_end[e].value, by_end[e].source(st.ticker, cik)) if e in by_end
                else Fact(None)
                for e in ends
            ]

    return st


def quarter_labels(st: Statements) -> list[tuple[str, bool]]:
    """Turn period-end dates into FQ-style labels an analyst reads at a glance."""
    out = []
    for e in st.quarters:
        y, m = int(e[:4]), int(e[5:7])
        out.append((f"Q{(m - 1) // 3 + 1} {y}", False))
    return out


def net_debt(st: Statements) -> list[Fact]:
    """Short-term debt + long-term debt − cash − short-term investments, per year."""
    out = []
    for i, _ in enumerate(st.years):
        parts = [
            (st.annual("short_term_debt")[i], 1),
            (st.annual("long_term_debt")[i], 1),
            (st.annual("cash")[i], -1),
            (st.annual("short_term_investments")[i], -1),
        ]
        vals = [(f, sign) for f, sign in parts if f.value is not None]
        if not any(sign > 0 for _, sign in vals):
            out.append(Fact(None))
            continue
        src = next((f.source for f, _ in vals if f.source), None)
        out.append(Fact(sum(f.value * sign for f, sign in vals), src))
    return out
