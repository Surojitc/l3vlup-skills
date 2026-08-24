# Calibration — teaching the output standard from real examples

The [output standard](../docs/output-standard.md) is currently derived from the TWC
model exporter and from the conventions taught on bulge-bracket training programmes.
That is a good starting point. Real examples are better.

## Read this before you add anything

**This repository is public.** Anything committed here is visible to everyone,
permanently, including in git history after a deletion.

So: `calibration/examples/` is **gitignored**. Drop files there freely — they stay on
your machine. What gets committed is only the *derived convention*: "IB comps sheets
put the median above the mean", "PE returns pages show the bridge before the IRR
table". Never the source document.

Before a file leaves your machine at all, check it is not:

- a live or unannounced deal, or anything else that is material non-public information
- covered by an NDA, an engagement letter or an employment agreement
- carrying a client name, a target name, a codename or a deal team roster
- carrying a fund's actual positions, marks or LP information
- watermarked, which most bank and fund output is

If in doubt the answer is no. A redacted example teaches the format just as well as an
unredacted one, because we are learning layout and convention, not content. Replace
real names with `Target`, `Acquirer`, `Fund I`; scale the numbers by an arbitrary
factor; strip the footer.

## What is most useful

Ranked by how much each would change the standard:

| Priority | What | Why it moves the needle |
|---|---|---|
| 1 | **Trading comps page** (bank format) | Row order, adjustments shown, where median vs mean sits, how NM is handled, calendarisation footnotes |
| 2 | **LBO returns page** (PE format) | Sources and uses layout, the returns bridge, sensitivity table format, entry/exit convention |
| 3 | **Operating model** (any) | Driver structure, how scenarios are toggled, where assumptions live relative to output |
| 4 | **Public-market one-pager** (HF format) | What a PM wants above the fold, position sizing presentation, thesis-to-number linkage |
| 5 | **IC memo** (PE/HF) | Section order, length discipline, where the risks section sits |
| 6 | **Pitchbook comps/valuation pages** | Football field construction, footnote density, source line conventions |

An example of a *bad* output is nearly as useful as a good one, if you can say what is
wrong with it.

## How to add one

1. Scrub it per the checklist above.
2. Drop it in `calibration/examples/` using this naming pattern, so the derived note
   can point at it without the file itself being needed:

   ```
   <assetclass>-<outputtype>-<sourcetype>-<nn>.<ext>
   ib-comps-bulge-01.xlsx
   pe-lbo-midmarket-02.xlsx
   hf-onepager-longshort-01.pdf
   ```

3. Add a line to `calibration/notes.md` saying what the file demonstrates. That file
   **is** committed, so keep it to conventions:

   ```
   ib-comps-bulge-01 — median printed ABOVE mean; NM shown as "NM" not blank;
   calendarised to Dec year-end with a footnote naming each off-cycle filer.
   ```

4. Tell Claude "calibrate the comps output against the new examples". The standard and
   the builders get amended, and the change shows up as a normal diff you can review.

## What calibration actually changes

Only three things, and it is worth being clear about the boundary:

- **Layout and convention** — row order, label wording, what sits above what, footnote
  style, how NM and NA are shown, column widths, where totals go.
- **Which metrics appear by default** — if every PE returns page you have shows a
  gross-to-net bridge, ours should too.
- **Wording of the teaching notes** — the vocabulary the industry actually uses.

It does **not** change the source policy. Historic financials come from filings
regardless of what any example does, because plenty of real bank output pulls
fundamentals from a licensed aggregator and we cannot and will not. If an example's
numbers came from Capital IQ, we take its *format* and keep our *sourcing*.
