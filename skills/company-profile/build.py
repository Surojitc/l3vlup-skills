#!/usr/bin/env python3
"""
Company Profile — banker one-pager, built entirely from SEC filings.

    python3 skills/company-profile/build.py AAPL --years 5 --out out/

Produces a workbook an associate can hand to an MD without reformatting:
Profile, Income Statement, Balance Sheet, Cash Flow and a Sources tab where every
figure resolves to a tag, a period and an accession number.

Margins, growth rates and derived metrics are FORMULAS (black) computed inside the
workbook, so the reader can trace them and change an input and watch them move.
Pulled filing values are BLUE. Nothing here is an estimate.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from lib import financials, lineitems as L  # noqa: E402
from lib.banker_xlsx import Book, Fact, Source  # noqa: E402
from lib import edgar  # noqa: E402


def _pct(sheet, num_row: int, den_row: int, n: int) -> list[str]:
    return [f'=IFERROR({sheet.col(k)}{num_row}/{sheet.col(k)}{den_row},"")' for k in range(n)]


def _growth(sheet, row: int, n: int) -> list[str]:
    out = [""]
    for k in range(1, n):
        a, b = sheet.col(k - 1), sheet.col(k)
        out.append(f'=IFERROR({b}{row}/{a}{row}-1,"")')
    return out


def build(ticker: str, years: int, out_dir: Path) -> Path:
    st = financials.load(ticker, years=years)
    n = len(st.years)
    if n == 0:
        raise SystemExit(f"No annual filing data found for {ticker} on EDGAR.")

    book = Book(f"{st.name} ({st.ticker})", period_caption="For Fiscal Year Ending")
    periods = st.period_labels

    # ---------------------------------------------------------------- Profile
    p = book.sheet("Profile", title="Company profile", periods=periods,
                   subtitle=f"Source: SEC EDGAR XBRL company facts · CIK {st.cik} · filings only")
    p.section("Scale")
    p.row("Revenue", st.annual("revenue"))
    rev = p.at()
    p.pct_row("% growth", _growth(p, rev, n))
    p.row("Gross profit", st.annual("gross_profit"))
    gp = p.at()
    p.pct_row("% margin", _pct(p, gp, rev, n))
    p.row("Operating income", st.annual("operating_income"))
    oi = p.at()
    p.pct_row("% margin", _pct(p, oi, rev, n))
    p.row("Net income", st.annual("net_income"))
    ni = p.at()
    p.pct_row("% margin", _pct(p, ni, rev, n))
    p.blank()

    p.section("Per share")
    p.row("Diluted EPS", st.annual("eps_diluted"), "S")
    p.row("Diluted shares outstanding", st.annual("shares_diluted"), "SH")
    p.blank()

    p.section("Cash generation")
    p.row("Cash from operations", st.annual("cfo"))
    cfo = p.at()
    p.row("Capital expenditure", st.annual("capex"))
    capex = p.at()
    p.row("Free cash flow", [f'=IFERROR({p.col(k)}{cfo}-{p.col(k)}{capex},"")' for k in range(n)],
          bold=True, formula=True)
    fcf = p.at()
    p.pct_row("% of revenue", _pct(p, fcf, rev, n))
    p.blank()

    p.section("Balance sheet")
    p.row("Cash and equivalents", st.annual("cash"))
    p.row("Short-term investments", st.annual("short_term_investments"))
    p.row("Total debt", [
        Fact(
            None if all(f.value is None for f in (st.annual("short_term_debt")[k],
                                                  st.annual("long_term_debt")[k]))
            else sum(f.value for f in (st.annual("short_term_debt")[k],
                                       st.annual("long_term_debt")[k]) if f.value is not None),
            next((f.source for f in (st.annual("long_term_debt")[k],
                                     st.annual("short_term_debt")[k]) if f.source), None),
        )
        for k in range(n)
    ])
    p.row("Net debt / (net cash)", financials.net_debt(st), bold=True)
    p.row("Total shareholders' equity", st.annual("equity"))
    p.blank()
    p.note("Blue = value as tagged in the filing. Black = formula computed in this workbook.")
    p.note("An em dash means the filer did not tag that line. It does not mean zero.")
    if st.missing:
        p.note("Not tagged by this filer: " + ", ".join(sorted(st.missing)[:12]))
    p.finish()

    # ------------------------------------------------------------- Statements
    def statement(name: str, layout, title: str) -> None:
        sh = book.sheet(name, title=title, periods=periods,
                        subtitle="As reported in the filings — original filing preferred "
                                 "over a later restatement's comparative")
        at: dict[str, int] = {}
        rev_row = None
        for label, key, marker, bold, indent in layout:
            sh.row(label, st.annual(key), marker, bold=bold, indent=indent)
            at[key] = sh.at()
            if key == "revenue":
                rev_row = at[key]
                sh.pct_row("% growth", _growth(sh, rev_row, n))
            elif rev_row and key in ("gross_profit", "operating_income", "net_income"):
                sh.pct_row("% margin", _pct(sh, at[key], rev_row, n))

        if name == "Balance Sheet":
            sh.blank()
            sh.row("Total liabilities and equity", st.annual("liabilities_and_equity"),
                   bold=True)
            at["liabilities_and_equity"] = sh.at()
            a_row, e_row = at.get("total_assets"), at.get("liabilities_and_equity")
            if a_row and e_row:
                sh.check("Balance check (assets less liabilities and equity)",
                         [f'=IFERROR(ROUND({sh.col(k)}{a_row}-{sh.col(k)}{e_row},0),0)'
                          for k in range(n)])
                sh.note("A non-zero balance check is highlighted red. It means the filer's "
                        "tagged totals do not tie, and the workbook should not be used "
                        "until the discrepancy is understood.")

        if name == "Cash Flow" and at.get("cfo") and at.get("capex"):
            sh.blank()
            sh.row("Free cash flow",
                   [f'=IFERROR({sh.col(k)}{at["cfo"]}-{sh.col(k)}{at["capex"]},"")'
                    for k in range(n)], bold=True, formula=True)
        sh.finish()

    statement("Income Statement", L.INCOME_LAYOUT, "Income statement")
    statement("Balance Sheet", L.BALANCE_LAYOUT, "Balance sheet")
    statement("Cash Flow", L.CASHFLOW_LAYOUT, "Cash flow statement")

    # ------------------------------------------------------------- Filings tab
    f = book.sheet("Filings", title="Filings used", periods=(),
                   subtitle="The primary documents behind every figure in this workbook",
                   units="")
    try:
        rows = edgar.latest_filings(st.cik, limit=12)
    except Exception:
        rows = []
    f.section("Recent annual and quarterly filings")
    for r in rows:
        f.row(f"{r['form']} · period {r['period'] or '—'} · filed {r['filed']}",
              [r["accession"]], "General")
    if not rows:
        f.note("Filing index unavailable at build time. Figures remain sourced on the Sources tab.")
    f.finish()

    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{st.ticker}_company_profile.xlsx"
    unsourced = ("Some lines are blank because the filer did not tag them — see the Profile tab note."
                 if st.missing else "")
    book.save(path, unsourced_note=unsourced)
    return path


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("ticker")
    ap.add_argument("--years", type=int, default=5)
    ap.add_argument("--out", default="out")
    a = ap.parse_args()
    path = build(a.ticker, a.years, Path(a.out))
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
