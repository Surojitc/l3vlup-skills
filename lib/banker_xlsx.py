"""
Banker house-style workbook writer.

Ported from the TWC model exporter (ClaudeSkills/scripts/fmp-model-export.py) so
L3VLUP skill outputs land in the same conventions an analyst already reads without
being told: blue is an input, black is a formula, green points at another sheet.

The one addition over the TWC original is PROVENANCE. Every figure can carry the
filing it came from; the writer collects those, numbers them, prints the marker
beside the row and emits a Sources sheet where each marker resolves to a tag,
period, form, accession number and a link to the filing on EDGAR. A number with
no provenance record is an unsourced number, and the workbook says so out loud.

Conventions (do not drift from these — they are the calibration contract):

  Colour       BLUE  = hard input / value pulled from a filing
               black = formula computed inside the workbook
               GREEN = link to another sheet
               NAVY  = headers, section labels, period row
               GREY  = notes, units, sub-rows

  Formats      D  $ in millions, negatives in parentheses
               P  percentage, one decimal
               X  multiple, one decimal, trailing "x"
               S  raw two-decimal (per-share)
               SH share count in millions
               N  plain integer

  Layout       column A gutter, B labels, C spacer, data from D
               gridlines off, landscape, fit-to-width, freeze panes at D7
               period row on row 6, header block on rows 2-5
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Sequence

import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.properties import PageSetupProperties

BLUE = "FF0000FF"
NAVY = "FF264D82"
GREEN = "FF008000"
GREY = "FF808080"
RED = "FFC00000"

GUTTER, LBL, SPACER, DATA0 = 1, 2, 3, 4

CURRENCY_SYMBOL = {
    "USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥",
    "CNY": "¥", "CHF": "CHF", "CAD": "C$", "AUD": "A$", "INR": "₹",
}

_THIN_BOTTOM = Border(bottom=Side(style="thin", color=NAVY))
_TOP_RULE = Border(top=Side(style="thin", color="FFBFBFBF"))


def fmt(marker: str, symbol: str = "$") -> str:
    """Excel number format for a house format marker."""
    if marker == "D":
        return f'"{symbol}"#,##0,,_);\\("{symbol}"#,##0,,\\)'
    if marker == "D0":  # already in millions, do not scale
        return f'"{symbol}"#,##0_);\\("{symbol}"#,##0\\)'
    if marker == "P":
        return '0.0%_);\\(0.0%\\)'
    if marker == "X":
        return '0.0"x"'
    if marker == "S":
        return '0.00_);\\(0.00\\)'
    if marker == "SH":
        return '#,##0,,_);\\(#,##0,,\\)'
    if marker == "N":
        return '#,##0'
    if marker == "BP":
        return '#,##0" bp"'
    return "General"


@dataclass(frozen=True)
class Source:
    """Where a number came from. Filings only for historic financials."""

    label: str                 # "AAPL FY2025 10-K"
    detail: str = ""           # "us-gaap:Revenues, FY2025, filed 2025-10-31"
    url: str = ""              # link to the filing on EDGAR
    accession: str = ""        # 0000320193-25-000073

    def key(self) -> str:
        return f"{self.label}|{self.detail}|{self.accession}"


@dataclass
class Fact:
    """A value plus the filing it came from."""

    value: float | int | str | None
    source: Source | None = None


def fact(value, source: Source | None = None) -> Fact:
    return Fact(value, source)


@dataclass
class _Row:
    label: str
    cells: list
    marker: str
    bold: bool
    italic: bool
    indent: bool
    colour: str | None
    rule: bool


class Sheet:
    """One tab. Rows are appended top to bottom; call finish() to lay out chrome."""

    def __init__(self, book: "Book", ws, title: str, periods: Sequence[tuple[str, bool]],
                 subtitle: str = "", units: str | None = None, link_to_summary: bool = True):
        self.book = book
        self.ws = ws
        self.title = title
        self.periods = list(periods)
        self.subtitle = subtitle
        self.units = units if units is not None else book.units
        self.link_to_summary = link_to_summary
        self._rows: list[_Row] = []
        self._r = 7  # first body row, header occupies 2-6

    # ---- content -------------------------------------------------------

    def section(self, label: str) -> "Sheet":
        c = self.ws.cell(self._r, LBL, label)
        c.font = Font(bold=True, color=NAVY, size=10)
        for k in range(len(self.periods) + 1):
            self.ws.cell(self._r, LBL + k if k == 0 else DATA0 + k - 1).border = _THIN_BOTTOM
        self._r += 1
        return self

    def blank(self, n: int = 1) -> "Sheet":
        self._r += n
        return self

    def row(self, label: str, cells: Iterable, marker: str = "D", *, bold: bool = False,
            italic: bool = False, indent: bool = False, formula: bool = False,
            link: bool = False, rule: bool = False) -> "Sheet":
        """
        cells — raw values (blue: pulled/hard input), Fact objects (blue + sourced),
        or strings beginning "=" (black: formula computed in the workbook).
        Pass formula=True to force black, link=True to force green.
        """
        cells = list(cells)
        lc = self.ws.cell(self._r, LBL, ("    " if indent else "") + label)
        lc.font = Font(bold=bold, italic=italic or indent,
                       color=(GREY if indent or italic else None), size=10)
        if rule:
            lc.border = _TOP_RULE

        for k, raw in enumerate(cells):
            src = None
            if isinstance(raw, Fact):
                src, raw = raw.source, raw.value
            cell = self.ws.cell(self._r, DATA0 + k)
            cell.number_format = fmt(marker, self.book.symbol)
            if rule:
                cell.border = _TOP_RULE
            if raw is None or raw == "":
                cell.value = "—"
                cell.font = Font(color=GREY, size=10)
                cell.alignment = Alignment(horizontal="right")
                continue
            cell.value = raw
            is_formula = formula or (isinstance(raw, str) and raw.startswith("="))
            colour = GREEN if link else (None if is_formula else BLUE)
            cell.font = Font(bold=bold, italic=italic, color=colour, size=10)
            if src is not None:
                self.book.note_source(src)

        # provenance marker column, one per row, right of the data
        srcs = [c.source for c in cells if isinstance(c, Fact) and c.source is not None]
        if srcs:
            ids = sorted({self.book.source_id(s) for s in srcs})
            mc = self.ws.cell(self._r, DATA0 + len(self.periods) + 1,
                              "".join(f"[{i}]" for i in ids))
            mc.font = Font(color=GREY, size=8)
            mc.alignment = Alignment(horizontal="left")

        self._r += 1
        return self

    def pct_row(self, label: str, formulas: Sequence[str]) -> "Sheet":
        """Grey italic margin/growth sub-row — always a formula, never a hard number."""
        return self.row(label, formulas, "P", italic=True, indent=True, formula=True)

    def note(self, text: str) -> "Sheet":
        c = self.ws.cell(self._r, LBL, text)
        c.font = Font(italic=True, color=GREY, size=8)
        self._r += 1
        return self

    def check(self, label: str, formulas: Sequence[str], marker: str = "D") -> "Sheet":
        """Balance / tie-out row: flags red when non-zero."""
        self.row(label, formulas, marker, italic=True, formula=True)
        r = self._r - 1
        first = get_column_letter(DATA0)
        last = get_column_letter(DATA0 + max(len(self.periods), 1) - 1)
        from openpyxl.formatting.rule import CellIsRule
        self.ws.conditional_formatting.add(
            f"{first}{r}:{last}{r}",
            CellIsRule(operator="notEqual", formula=["0"],
                       font=Font(bold=True, color="FFFFFFFF"),
                       fill=PatternFill("solid", fgColor=RED)),
        )
        return self

    # ---- chrome --------------------------------------------------------

    @property
    def cursor(self) -> int:
        """Row number the next write lands on."""
        return self._r

    def at(self, back: int = 1) -> int:
        """Row number of the row written `back` writes ago (1 = the last one)."""
        return self._r - back

    def col(self, index: int) -> str:
        """Column letter for period index (0-based) — for writing cross-sheet formulas."""
        return get_column_letter(DATA0 + index)

    def finish(self) -> "Sheet":
        ws, n = self.ws, len(self.periods)

        if self.link_to_summary and self.book.has_summary and self.title != self.book.summary_name:
            ws.cell(2, LBL, f"=+'{self.book.summary_name}'!B2").font = Font(bold=True, color=GREEN, size=11)
        else:
            ws.cell(2, LBL, self.book.company).font = Font(bold=True, color=NAVY, size=11)
        ws.cell(3, LBL, self.title).font = Font(bold=True, color=NAVY, size=12)
        if self.subtitle:
            ws.cell(4, LBL, self.subtitle).font = Font(italic=True, color=GREY, size=9)
        if self.units:
            ws.cell(5, LBL, self.units).font = Font(italic=True, color=GREY, size=9)

        if self.periods:
            ws.cell(5, DATA0, self.book.period_caption).font = Font(bold=True, color=NAVY, size=9)
            for k, (label, is_est) in enumerate(self.periods):
                c = ws.cell(6, DATA0 + k, label)
                c.font = Font(bold=True, color=NAVY, size=10)
                c.alignment = Alignment(horizontal="right")
                c.border = _THIN_BOTTOM
            if self.book.sources:
                sc = ws.cell(6, DATA0 + n + 1, "Src")
                sc.font = Font(bold=True, color=GREY, size=8)

        ws.sheet_view.showGridLines = False
        ws.page_setup.orientation = "landscape"
        ws.page_setup.fitToWidth = 1
        ws.page_setup.fitToHeight = 0
        ws.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)
        ws.column_dimensions["A"].width = 3
        ws.column_dimensions["B"].width = 38
        ws.column_dimensions["C"].width = 1.7
        for k in range(max(n, 1)):
            ws.column_dimensions[get_column_letter(DATA0 + k)].width = 13
        ws.column_dimensions[get_column_letter(DATA0 + n)].width = 1.7
        ws.column_dimensions[get_column_letter(DATA0 + n + 1)].width = 10

        last_col = get_column_letter(DATA0 + max(n, 1) + 1)
        ws.print_area = f"B2:{last_col}{max(self._r, 8)}"
        ws.freeze_panes = "D7"
        return self


class Book:
    """A workbook in the house style, with a Sources tab wired to every figure."""

    def __init__(self, company: str, *, currency: str = "USD",
                 units: str = "($ in millions, except per share)",
                 period_caption: str = "For Fiscal Year Ending",
                 summary_name: str = "Summary"):
        self.company = company
        self.currency = currency
        self.symbol = CURRENCY_SYMBOL.get(currency, currency + " ")
        self.units = units
        self.period_caption = period_caption
        self.summary_name = summary_name
        self.has_summary = False
        self.wb = openpyxl.Workbook()
        self.wb.remove(self.wb.active)
        self.sources: dict[str, tuple[int, Source]] = {}
        self._sheets: list[Sheet] = []

    def note_source(self, s: Source) -> int:
        return self.source_id(s)

    def source_id(self, s: Source) -> int:
        k = s.key()
        if k not in self.sources:
            self.sources[k] = (len(self.sources) + 1, s)
        return self.sources[k][0]

    def sheet(self, name: str, *, title: str | None = None,
              periods: Sequence[tuple[str, bool]] = (), subtitle: str = "",
              units: str | None = None) -> Sheet:
        ws = self.wb.create_sheet(name[:31])
        if name == self.summary_name:
            self.has_summary = True
        sh = Sheet(self, ws, title or name, periods, subtitle=subtitle, units=units)
        self._sheets.append(sh)
        return sh

    def write_sources_sheet(self, *, unsourced_note: str = "") -> None:
        """
        The audit trail. Emitted last so it sees every figure written above it.
        This is the tab that separates a workbook you can defend from one you cannot.
        """
        ws = self.wb.create_sheet("Sources")
        ws.cell(2, LBL, self.company).font = Font(bold=True, color=NAVY, size=11)
        ws.cell(3, LBL, "Sources and audit trail").font = Font(bold=True, color=NAVY, size=12)
        ws.cell(4, LBL, "Every marker in the [n] column of any tab resolves here. "
                        "Historic financials come from filings, never from an aggregator."
                ).font = Font(italic=True, color=GREY, size=9)
        if unsourced_note:
            ws.cell(5, LBL, unsourced_note).font = Font(italic=True, color=RED, size=9)

        heads = ["#", "Source", "Detail", "Accession", "Link"]
        for k, h in enumerate(heads):
            c = ws.cell(7, LBL + k, h)
            c.font = Font(bold=True, color=NAVY, size=10)
            c.border = _THIN_BOTTOM

        r = 8
        for _, (i, s) in sorted(self.sources.items(), key=lambda kv: kv[1][0]):
            ws.cell(r, LBL, i).font = Font(color=GREY, size=9)
            ws.cell(r, LBL + 1, s.label).font = Font(size=10)
            ws.cell(r, LBL + 2, s.detail).font = Font(color=GREY, size=9)
            ws.cell(r, LBL + 3, s.accession).font = Font(color=GREY, size=9)
            if s.url:
                c = ws.cell(r, LBL + 4, s.url)
                c.hyperlink = s.url
                c.font = Font(color="FF0563C1", underline="single", size=9)
            r += 1

        if not self.sources:
            ws.cell(8, LBL + 1, "No sourced figures in this workbook.").font = Font(
                italic=True, color=RED, size=10)

        ws.sheet_view.showGridLines = False
        ws.column_dimensions["A"].width = 3
        ws.column_dimensions["B"].width = 4
        ws.column_dimensions["C"].width = 34
        ws.column_dimensions["D"].width = 56
        ws.column_dimensions["E"].width = 24
        ws.column_dimensions["F"].width = 70
        ws.freeze_panes = "C8"

    def save(self, path, *, unsourced_note: str = "") -> None:
        self.write_sources_sheet(unsourced_note=unsourced_note)
        self.wb.save(path)
