#!/usr/bin/env python3
"""
A company with several share classes is counted in all the classes the merger buys on the same terms.

    python3 scripts/__tests__/precedent-share-classes.test.py

WHY THIS EXISTS
---------------
Where the company facts carry no share count at announcement, a row takes the
count its transaction statement states (parse.stated_shares). A filing that
states its classes separately ("80,653,284 Class A ordinary shares and
109,386,066 Class B ordinary shares issued and outstanding") was read one count
at a time, and the count stated most often won: one class of two. Sungy's
equity value was its Class A alone, $65.9m of $155.2m; Perfect World's
$119.9m against a fee table of $868.7m; BBX Capital's its 195,045 Class B
shares, $2.0m; Emdeon's its Class B, $469.1m against a fee table of $2,246.4m.
In two Liberty Interactive proxies the count was another company's (Expedia's,
Liberty Ventures'), and in Cablevision's the 1.4 billion Class A shares its
charter authorizes.

The reader now finds the sentences that state each class's count at one
date, sums the classes the filing shows receive the merger consideration on
the same terms per share (a clause whose subject names them, directly or as a
term defined as them together, converted into the right to receive the
offer), leaves out a class it shows is not acquired and names it, and gives no
count at all where a class's terms are not shown or differ: one class of
several is not the company's count, and a count is never made up. A count
whose words name another company is passed over, and so is an authorized
total. Economic ownership, not the number of classes in the capitalisation table,
decides what is counted. A class with votes and no economic rights
(Endeavor's Class X and Y), a class cancelled for no consideration, or one
paid a nominal sum for its votes (Pluralsight's Class B and C, $0.0001) is
left out and named with the reason. Where the filing prices each class
reliably, equity value is each class's count times its own price (Unified
Grocers' Class E at $100.00 beside $200.27). The fee table is a cross-check,
read for its perimeter first (perimeter.py): Landry's fee table counts only
the 7,341,052 shares of holders other than Mr. Fertitta, so its raw ratio of
2.20 is the perimeter, and like for like it is 1.00. The financials reader moves to version 5, so every change is recorded
by the guard as a revision with its cause, and a row whose only change is the
version is stamped without asking EDGAR for anything.

Every figure below is worked by hand from the filing's own words, quoted in
the comment beside it. The fixtures are the sentences of each deal's real
documents that the reader reads (every count beside "outstanding", every
clause that converts shares into the right to receive, every definition), and
the fee-table passage, as EDGAR serves them; the reading was checked to be the
same over each excerpt as over its whole document.
"""

from __future__ import annotations

import copy
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from precedent_transactions import database, filings, guard, parse, perimeter  # noqa: E402

FIX = {d["key"]: d for d in json.loads((ROOT / "scripts" / "__tests__" / "fixtures" / "precedent-share-classes.json").read_text())}
passed = failed = 0


def eq(name, got, want):
    global passed, failed
    ok = got == want
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f" — got {got!r}, want {want!r}"))
    if ok:
        passed += 1
    else:
        failed += 1


DOCS = {d["url"]: d["text"] for f in FIX.values() for d in f["documents"]}


def fixture_fetch(url, accept="text/html", tries=3, cap=None):
    return DOCS[url]


def no_facts(url):
    raise AssertionError(f"company facts asked for: {url}")


def stored(key: str) -> dict:
    """The row as #190's reading left it. A 404 marker is dated today, so the six months it waits are never up while the suite runs."""
    row = copy.deepcopy(FIX[key]["stored"])
    if row.get("companyFactsMissing"):
        row["companyFactsMissing"] = date.today().isoformat()
    return row


def reread(key: str) -> dict:
    """The stored row's financials read again at this version, from the fixture's documents and never the company facts."""
    row = stored(key)
    real = filings.fetch, filings.to_text, filings.fetch_json
    filings.fetch, filings.to_text, filings.fetch_json = fixture_fetch, (lambda raw: raw), no_facts
    try:
        filings.reread_financials(row)
    finally:
        filings.fetch, filings.to_text, filings.fetch_json = real
    return database.finalize(row)


def text(key: str, i: int = -1) -> str:
    return FIX[key]["documents"][i]["text"]


rows = {k: reread(k) for k in FIX}

# ── two classes, one price: summed ───────────────────────────────────────────

o, s = rows["GOMO"], FIX["GOMO"]["stored"]
# "The Company’s net book value per Share as of December 31, 2014 was US$0.65
# based on 66,866,388 Class A ordinary shares, and 123,172,962 Class B ordinary
# shares issued and outstanding", and "as of March 31, 2015, which was US$0.60
# based on 80,653,284 Class A ordinary shares and 109,386,066 Class B ordinary
# shares": 66,866,388 + 123,172,962 = 190,039,350 = 80,653,284 + 109,386,066
# (Class B converted into Class A between the dates). The merger agreement:
# "Each Class A ordinary share ... and each Class B ordinary share ... (... the
# “Shares”) ... shall be cancelled ... in exchange for the right of the holder
# of such Share to receive US$0.81667". $0.8166 x 190.039m = $155.186m.
eq("Sungy: stored as its Class A alone", (s["sharesOut"], s["statedSharesBasis"]), (80.653, "80,653,284 Class A ordinary shares and 109,386,066 Class B ordinary shares issued and outstanding"))
eq("Sungy: 66,866,388 + 123,172,962 = 80,653,284 + 109,386,066 = 190,039,350", (66_866_388 + 123_172_962, 80_653_284 + 109_386_066), (190_039_350, 190_039_350))
eq("Sungy: the count is both classes, 190.039m", o["sharesOut"], 190.039)
eq("Sungy: equity value $0.8166 x 190.039m = $155.2m, not $65.9m", (o["equityValue"], round(0.8166 * 190.039, 1)), (155.2, 155.2))
eq("Sungy: sharesBasis names the classes summed and quotes the terms", (o["sharesBasis"]["tag"], o["sharesBasis"]["classes"], "US$0.81667" in o["sharesBasis"]["terms"]), (filings.STATED, ["Class A", "Class B"], True))
# Fee table: "Transactional valuation* ... $89,735,654.44", on the shares not
# rolled over (81,319,765 Class B shares roll over). $155.2m / $89.7m = 1.73.
eq("Sungy: the fee table's $89,735,654.44 is in the cover", "$89,735,654.44" in text("GOMO", 0), True)
eq("Sungy: $155.2m / $89.7m = 1.73, inside the 0.5 to 12 the check allows", round(o["equityValue"] / 89.73565444, 2), 1.73)

p, s = rows["PWRD"], FIX["PWRD"]["stored"]
# "As of the date of this Agreement, (i) 29,671,195 Class A Shares are issued
# and outstanding, ... (ii) 219,266,335 Class B Shares are issued and
# outstanding"; "each issued and outstanding Share and ADS ... will be
# cancelled in exchange for the right to receive the Per Share Merger
# Consideration". 29,671,195 + 219,266,335 = 248,937,530; $4.04 x 248.938m =
# $1,005.709m.
eq("Perfect World: stored as its Class A alone, $119.9m", (s["sharesOut"], round(s["sharesOut"] * s["offerPrice"], 1)), (29.671, 119.9))
eq("Perfect World: 29,671,195 + 219,266,335 = 248,937,530", 29_671_195 + 219_266_335, 248_937_530)
eq("Perfect World: the count is both classes, 248.938m, and equity value $1,005.7m", (p["sharesOut"], p["equityValue"]), (248.938, 1005.7))
# Fee table: "Transactional Valuation* ... US$868,702,717.51", on the shares
# not rolled over. $1,005.7m / $868.7m = 1.16, where $119.9m was 0.14.
eq("Perfect World: the fee table's US$868,702,717.51 is in the cover", "US$868,702,717.51" in text("PWRD", 0), True)
eq("Perfect World: $1,005.7m / $868.7m = 1.16; $119.9m / $868.7m was 0.14", (round(p["equityValue"] / 868.70271751, 2), round(119.9 / 868.70271751, 2)), (1.16, 0.14))

c = rows["CHNG"]
# Emdeon (now Change Healthcare Holdings), an Up-C: "91,213,582 shares of
# Emdeon Class A common stock and 24,689,142 shares of Emdeon Class B common
# stock, outstanding"; "each share of Emdeon Class A common stock (including
# each share of Emdeon Class A common stock resulting from the exchange of
# units of membership interests (“EBS Units”) ... and corresponding shares of
# Emdeon Class B common stock ...) ... will be converted into the right to
# receive $19.00 in cash". The Class B is acquired as the Class A it is
# exchanged into. 91,213,582 + 24,689,142 = 115,902,724; $19.00 x 115.903m =
# $2,202.157m.
eq("Emdeon: stored as its Class B alone, $469.1m", (FIX["CHNG"]["stored"]["sharesOut"], FIX["CHNG"]["stored"]["statedSharesBasis"]), (24.689, "24,689,142 shares of Emdeon Class B common stock, outstanding"))
eq("Emdeon: 91,213,582 + 24,689,142 = 115,902,724", 91_213_582 + 24_689_142, 115_902_724)
eq("Emdeon: the Class B exchanged into Class A before the merger counts with it: 115.903m, $2,202.2m", (c["sharesOut"], c["equityValue"], c["sharesBasis"]["classes"]), (115.903, 2202.2, ["Class A", "Class B"]))
# Fee table: "$2,246,390,833.73". $2,202.2m / $2,246.4m = 0.98; $469.1m was 0.21.
eq("Emdeon: the fee table's $2,246,390,833.73 is in the cover", "$2,246,390,833.73" in text("CHNG", 0), True)
eq("Emdeon: $2,202.2m / $2,246.4m = 0.98, where $469.1m was 0.21", (round(c["equityValue"] / 2246.39083373, 2), round(469.1 / 2246.39083373, 2)), (0.98, 0.21))

j = rows["JAXB"]
# "there were 3,512,773 shares of JAXB voting common stock, and 2,287,821
# shares of JAXB nonvoting common stock (which we refer to together as the
# “JAXB common stock”), outstanding"; "each share of JAXB common stock ...
# will be converted into the right to receive either: • 0.5861 shares ... of
# ABCB common stock; or • $16.50 in cash". 3,512,773 + 2,287,821 = 5,800,594;
# $16.50 x 5.801m = $95.710m.
eq("Jacksonville Bancorp: voting and nonvoting common, 3,512,773 + 2,287,821 = 5,800,594", 3_512_773 + 2_287_821, 5_800_594)
eq("Jacksonville Bancorp: the count is both, 5.801m, and equity value $95.7m, not $58.0m", (FIX["JAXB"]["stored"]["sharesOut"], j["sharesOut"], j["equityValue"]), (3.513, 5.801, 95.7))
eq("Jacksonville Bancorp: the classes summed are named", j["sharesBasis"]["classes"], ["the voting common stock", "the nonvoting common stock"])

b = rows["BBX16"]
# "As of the close of business on the record date, 16,483,866 shares of BBX
# Capital’s Class A Common Stock and 195,045 shares of BBX Capital’s Class B
# Common Stock were outstanding"; "BBX Capital’s Class A Common Stock and
# Class B Common Stock (collectively, “BBX Capital Common Stock”) that is
# issued and outstanding ... will be converted into the right to receive, at
# the election of the holder thereof, either: (i) 5.40 shares ... or (ii)
# $20.00 in cash". 16,483,866 + 195,045 = 16,678,911; $20.00 x 16.679m =
# $333.578m. The same document states "73,637,880 shares of BFC’s Class A
# Common Stock, 15,002,233 shares of BFC’s Class B Common Stock ... were
# issued and outstanding": the acquirer's, never the count.
eq("BBX Capital (2016): stored as its 195,045 Class B shares, $3.9m", (FIX["BBX16"]["stored"]["sharesOut"], round(FIX["BBX16"]["stored"]["sharesOut"] * 20.0, 1)), (0.195, 3.9))
eq("BBX Capital (2016): 16,483,866 + 195,045 = 16,678,911", 16_483_866 + 195_045, 16_678_911)
eq("BBX Capital (2016): both classes, 16.679m, $333.6m", (b["sharesOut"], b["equityValue"]), (16.679, 333.6))
eq("BBX Capital (2016): the acquirer BFC's classes are in the document and are not read", ("73,637,880 shares of BFC’s Class A Common Stock" in text("BBX16"), b["statedSharesBasis"].startswith("16,483,866 shares of BBX Capital")), (True, True))

v = rows["CVC"]
# "The authorized capital stock of the Company consists of 1,400,000,000 Class
# A Shares, of which 222,603,582 Shares were outstanding": 1.4 billion is what
# the charter authorizes, and it was the stored count ($48,860m at $34.90). The
# count: "222,581,890 Class A Shares (including 6,897,528 restricted Class A
# Shares) and 54,137,673 Class B Shares issued and outstanding"; "each Class A
# Share and Class B Share (... collectively, the “Shares”) ... will be
# cancelled and converted automatically into the right to receive $34.90 in
# cash". 222,581,890 + 54,137,673 = 276,719,563; $34.90 x 276.720m =
# $9,657.528m.
eq("Cablevision: stored as the 1.4 billion Class A shares its charter authorizes", (FIX["CVC"]["stored"]["sharesOut"], FIX["CVC"]["stored"]["statedSharesBasis"]), (1400.0, "1,400,000,000 Class A Shares, of which 222,603,582 Shares were outstanding"))
eq("Cablevision: 222,581,890 + 54,137,673 = 276,719,563", 222_581_890 + 54_137_673, 276_719_563)
eq("Cablevision: both classes outstanding, 276.72m, $9,657.5m", (v["sharesOut"], v["equityValue"]), (276.72, 9657.5))

# ── classes whose terms the filing does not show: no count ───────────────────

x = rows["BBX14"]
# "As of the close of business on the record date, 17,088,390 shares of BBX
# Capital’s Class A Common Stock and 195,045 shares of BBX Capital’s Class B
# Common Stock were outstanding". The merger converts "each share of BBX
# Capital’s Class A Common Stock outstanding at the effective time of the
# merger (other than shares owned by BFC ...)"; what the Class B, all owned by
# BFC, receives is not stated as the same. So no count: not the 195,045 Class
# B shares ($2.0m at $10.00), and not the Class A alone.
eq("BBX Capital (2014): stored as its 195,045 Class B shares, $2.0m", (FIX["BBX14"]["stored"]["sharesOut"], round(FIX["BBX14"]["stored"]["sharesOut"] * 10.0, 1)), (0.195, 2.0))
eq("BBX Capital (2014): no count and no equity value", (x.get("sharesOut"), x.get("equityValue"), x.get("statedShares")), (None, None, None))
eq("BBX Capital (2014): the row says which classes and why", x["statedSharesClasses"], {
    "classes": [{"class": "A", "count": 17.088}, {"class": "B", "count": 0.195}],
    "why": "the filing states Class A, Class B outstanding and does not show that they receive the same consideration per share"})

# ── another company's count: never read ──────────────────────────────────────

q = rows["QVC16"]
# Liberty Interactive's proxy for the Expedia Holdings split-off: "137,008,911
# shares of EXPE and 12,799,999 shares of Expedia class B common stock, in
# each case, outstanding on August 1, 2016" is Expedia's count, and it was the
# row's ($1,390.6m at $10.15). The document states none of the target's own.
eq("Old QVC (Liberty Interactive): stored as Expedia's count", (FIX["QVC16"]["stored"]["sharesOut"], FIX["QVC16"]["stored"]["statedSharesBasis"]), (137.009, "137,008,911 shares of EXPE and 12,799,999 shares of Expedia class B common stock, in each case, outstanding"))
eq("Old QVC: Expedia's count is in the document", "137,008,911 shares of EXPE" in text("QVC16"), True)
eq("Old QVC: and is not read: no count, no equity value", (q.get("sharesOut"), q.get("equityValue"), q.get("statedShares")), (None, None, None))

# ── economic ownership: a class without it is not counted ───────────────────

e = rows["EDR"]
# "Our Class X Common Stock and Class Y Common Stock do not have any of the
# economic rights (including rights to dividends and distributions upon
# liquidation) associated with our Class A Common Stock", and "each share of
# Company Class X Common Stock and Company Class Y Common Stock ... shall
# automatically be cancelled without any conversion". The count is the Class A
# alone: "307,864,479 shares of Class A Common Stock outstanding"; $27.50 x
# 307.864m = $8,466.273m. Summed with the 160,244,257 Class X and 216,020,232
# Class Y shares it read 684.129m and $18,813.5m.
eq("Endeavor: stored as its 160,244,257 Class X shares", (FIX["EDR"]["stored"]["sharesOut"], FIX["EDR"]["stored"]["statedSharesBasis"]), (160.244, "160,244,257 shares of Class X Common Stock outstanding"))
eq("Endeavor: the count is the Class A alone, 307.864m, $8,466.3m", (e["sharesOut"], e["equityValue"], round(27.5 * 307.864479, 1)), (307.864, 8466.3, 8466.3))
eq("Endeavor: Class X and Y are named as excluded, with the filing's reason",
   [(x["class"], x["why"].split(":")[0]) for x in e["sharesBasis"]["excluded"]],
   [("Class X", "voting rights only, no economic interest"), ("Class Y", "voting rights only, no economic interest")])
eq("Endeavor: the reason quotes the filing", "do not have any of the economic rights" in e["sharesBasis"]["excluded"][0]["why"], True)
# Fee table $7,250m (the dealValue the row carries): $8,466.3m / $7,250m =
# 1.17; summing X and Y read 2.59.
eq("Endeavor: $8,466.3m / $7,250m = 1.17, where all three classes read 2.59", (e["dealValueRatio"], round(18813.5 / 7250, 2)), (1.17, 2.59))

pl = rows["PLUR"]
# "each share of Class B common stock and each share of Class C common stock,
# which correspond on a one-for-one basis with the Holdings units ... will be
# cancelled and automatically converted into the right to receive cash in an
# amount equal to $0.0001", beside "$20.26" for each Class A share: a payment
# for votes, under 1% of the offer. The count is the Class A: 122,729,434;
# $20.26 x 122.729m = $2,486.498m.
eq("Pluralsight: stored as its 13,400,787 Class C shares", FIX["PLUR"]["stored"]["sharesOut"], 13.401)
eq("Pluralsight: the Class A alone, 122.729m, $2,486.5m", (pl["sharesOut"], pl["equityValue"], round(20.26 * 122.729434, 1)), (122.729, 2486.5, 2486.5))
eq("Pluralsight: Class B and C are named as paid a nominal $0.0001", [(x["class"], x["why"].split(":")[0]) for x in pl["sharesBasis"]["excluded"]],
   [("Class B", "nominal consideration of $0.0001 a share against the offer's $20.26"), ("Class C", "nominal consideration of $0.0001 a share against the offer's $20.26")])

nf = rows["NEFF"]
# "the Company had 8,897,535 shares of Class A Common Stock issued and
# outstanding and 14,951,625 shares of Class B Common Stock issued and
# outstanding, all of which will be cancelled as a result of the Exchanges"
# (the LLC units and their Class B shares are exchanged for Class A first),
# and "each share of ... Class A Common Stock ... after giving effect to the
# Exchanges ... shall be ... converted into the right to receive $25.00". The
# Class B is bought as the Class A it becomes: 8,897,535 + 14,951,625 =
# 23,849,160; $25.00 x 23.849m = $596.229m.
eq("Neff: stored as its Class A alone, $222.4m", (FIX["NEFF"]["stored"]["sharesOut"], round(FIX["NEFF"]["stored"]["sharesOut"] * 25.0, 1)), (8.898, 222.4))
eq("Neff: 8,897,535 + 14,951,625 = 23,849,160, $596.2m", (nf["sharesOut"], nf["equityValue"], 8_897_535 + 14_951_625), (23.849, 596.2, 23_849_160))

# ── each class at its own price ──────────────────────────────────────────────

ug = rows["UGRO"]
# "121,450 Class A Shares outstanding ..., (ii) 403,325 Class B Shares
# outstanding ... and (iii) 86,254 Class E Shares outstanding"; "the right to
# receive $200.27 per share in cash, which we sometimes refer to as the
# merger consideration per Class A Share and Class B Share", and "Each Class
# E Share ... will be converted into the right to receive $100.00 per share in
# cash". (121,450 + 403,325) x $200.27 = $105,096,689.25; 86,254 x $100.00 =
# $8,625,400; together $113,722,089.25.
eq("Unified Grocers: stored as its Class A alone, 121,450 shares", FIX["UGRO"]["stored"]["sharesOut"], 0.121)
eq("Unified Grocers: (121,450 + 403,325) x $200.27 + 86,254 x $100.00 = $113,722,089.25", round((121_450 + 403_325) * 200.27 + 86_254 * 100.0, 2), 113_722_089.25)
eq("Unified Grocers: equity value is each class at its own price, $113.7m (not $200.27 x all 611,029 shares, $122.4m)", (ug["equityValue"], ug["sharesOut"], round(200.27 * 0.611029, 1)), (113.7, 0.611, 122.4))
eq("Unified Grocers: each class's price is kept with its passage", [(x["class"], x["count"], x["price"], "$100.00" in (x["terms"] or "")) for x in ug["sharesBasis"]["classPrices"]],
   [("Class A", 0.12145, None, False), ("Class B", 0.403325, None, False), ("Class E", 0.086254, 100.0, True)])

# ── the target's own count, under its own or former name ─────────────────────

px = rows["PFX"]
# PhenixFIN's merger proxy was filed as "MEDLEY CAPITAL CORPORATION (Name of
# Registrant as Specified In Its Charter)", and states "As of the MCC Record
# Date, there were 54,474,211 shares of MCC Common Stock outstanding": the
# target's count under its former name and short name. The same proxy's
# financial highlights read "Net assets at end of year $ 729,856,881 Shares
# outstanding at end of year 54,474,211": net assets, not shares.
eq("PhenixFIN: the documents' cover gives the name the target filed under", filings.target_names(FIX["PFX"]["stored"], [d["url"] for d in FIX["PFX"]["documents"]], [d["text"] for d in FIX["PFX"]["documents"]]), ("PhenixFIN Corp", "MEDLEY CAPITAL CORPORATION"))
eq("PhenixFIN: the count is MCC's own 54,474,211 shares", (px["sharesOut"], px["statedSharesBasis"]), (54.474, "54,474,211 shares of MCC Common Stock outstanding"))
eq("PhenixFIN: a dollar figure is never a count of shares", parse.parse_shares("Net assets at end of year $ 729,856,881 Shares outstanding at end of year 54,474,211"), (None, None))
MCC = ("I am writing to you on behalf of the board of directors (the “ MCC Board ”) of Medley Capital Corporation (“ MCC ”) to ask for your vote. "
       "As of the MCC Record Date, there were 54,474,211 shares of MCC Common Stock outstanding. There were 729,856,881 Shares outstanding. There were 729,856,881 Shares outstanding.")
eq("an unnamed count never beats the target's named one, however often it is stated", parse.parse_shares(MCC, company=("PhenixFIN Corp", "MEDLEY CAPITAL CORPORATION")), (54.474211, "54,474,211 shares of MCC Common Stock outstanding"))

fs = rows["FSIC3"]
# FS Investment Corporation III's proxy, filed under that name: "there were
# approximately 291,127,422 shares of FSIC III Common Stock outstanding". The
# 0.285m an earlier draft of this reader took was "On May 21, 2018, the Company
# offered to purchase 284,984 shares of its issued and outstanding common
# shares at a purchase price of $9.24 per share": a tender, not the shares
# outstanding. (The row's $9.24 offer is that tender's price, not the merger's
# consideration: a question for the offer reader, not the share count.)
eq("FS Investment Corp III: stored as the 250,000,000 shares its charter authorizes", FIX["FSIC3"]["stored"]["sharesOut"], 250.0)
eq("FS Investment Corp III: the count is its own 291,127,422 shares", (fs["sharesOut"], fs["statedSharesBasis"]), (291.127, "291,127,422 shares of FSIC III Common Stock outstanding"))
eq("FS Investment Corp III: a tender's count is never the shares outstanding", parse.parse_shares("On May 21, 2018, the Company offered to purchase 284,984 shares of its issued and outstanding common shares at a purchase price of $9.24 per share."), (None, None))
eq("FS Investment Corp III: FSIC II's and FSIC IV's counts are other companies'", parse.parse_shares("As of the Record Date, there were 327,309,962 shares of FSIC II Common Stock outstanding and 31,674,734 shares of FSIC IV Common Stock outstanding.", company=("FS Investment Corp III", "FS INVESTMENT CORPORATION III"), evidence=[d["text"] for d in FIX["FSIC3"]["documents"]]), (None, None))

# ── a single class: unchanged ────────────────────────────────────────────────

sw = rows["SWLL"]
# SonicWall has one class: "As of the record date, there were 55,359,131
# shares of common stock outstanding"; $11.50 x 55.359m = $636.629m.
eq("SonicWall: one class, read as before: 55.359m, $636.6m", (sw["sharesOut"], sw["equityValue"], sw["sharesBasis"]), (55.359, 636.6, {"tag": filings.STATED, "phrase": "55,359,131 shares of common stock outstanding"}))
eq("SonicWall: no class detail on a single class", sw.get("statedSharesClasses"), None)

# ── the fee table: perimeter first, then like for like ───────────────────────

n = rows["LNY"]
# Landry's: "On the record date, there were 16,235,207 shares of our common
# stock outstanding". The count stored was "7,341,052 shares of common stock
# outstanding and held by stockholders other than Mr. Fertitta, Parent and
# Merger Sub": the public's shares only. $24.50 x 16.235m = $397.763m.
eq("Landry's: stored as the 7,341,052 shares of holders other than Mr. Fertitta", FIX["LNY"]["stored"]["sharesOut"], 7.341)
eq("Landry's: the count is all 16,235,207 shares outstanding, $397.8m", (n["sharesOut"], n["equityValue"], n["statedSharesBasis"]), (16.235, 397.8, "16,235,207 shares of our common stock outstanding"))
c = perimeter.compare(n, [d["text"] for d in FIX["LNY"]["documents"]], [d["url"] for d in FIX["LNY"]["documents"]])
# The fee table: "(2) Aggregate number of securities to which transaction
# applies: 7,341,052 shares of Landry’s Common Stock and 63,919 options",
# "Proposed maximum aggregate value of transaction: $180,444,910". Raw: $397.8m
# / $180.4m = 2.20. The proxy states Mr. Fertitta "will contribute to Parent
# 8,894,155 shares of our common stock": 16,235,207 - 8,894,155 = 7,341,052,
# the fee table's count exactly. Like for like: $24.50 x 7.341m + the options'
# $0.6m = $180.4m, 1.00.
eq("Landry's fee table: $180.4m, counting 7.341m shares and the options", (c["feeTable"], c["feeShares"], c["perimeter"]), (180.44491, 7.341, ["public only", "awards included"]))
eq("Landry's: 16,235,207 - 8,894,155 = 7,341,052, the fee table's own count", 16_235_207 - 8_894_155, 7_341_052)
eq("Landry's: the shares left out are the 8,894,155 Mr. Fertitta contributes, as the proxy states", (c["excludedStated"], "8,894,155 shares" in c["excludedPassages"][0]), (8.894, True))
eq("Landry's: raw 2.20, like for like 1.00, so the difference is the perimeter", (c["rawRatio"], c["adjustedRatio"], c["status"]), (2.2, 1.0, "agrees like for like"))
eq("Landry's: the fee table's document and accession are named", (c["feeUrl"], c["feeAccession"]), ("https://www.sec.gov/Archives/edgar/data/908652/000119312510191332/ddefm14a.htm", "0001193125-10-191332"))

c = perimeter.compare(rows["GOMO"], [d["text"] for d in FIX["GOMO"]["documents"]], [d["url"] for d in FIX["GOMO"]["documents"]])
# Sungy's fee table: "$0.81667 for 106,574,161 issued and outstanding ordinary
# shares ... (excluding vested and unvested restricted shares and Rollover
# Shares)", plus 3,391,108 option shares and "1,369,289 issued and outstanding
# restricted share[s]". Left out: "81,319,765 Class B ordinary shares held by
# the Rollover Shareholders". 190.039m - 1.369m - 81.320m = 107.350m, x
# $0.8166 = $87.66m, plus the awards' $2.7m = $90.4m: 1.01 of $89.7m.
eq("Sungy fee table: public only, awards included, 106.574m shares", (c["perimeter"], c["feeShares"]), (["public only", "awards included"], 106.574))
eq("Sungy: the rollover shares the filing states are the shares left out", (c["excludedStated"], "81,319,765 Class B ordinary shares held by the Rollover Shareholders" in c["excludedPassages"][0]), (81.32, True))
eq("Sungy: raw 1.73, like for like 1.01", (c["rawRatio"], c["adjustedRatio"]), (1.73, 1.01))

c = perimeter.compare(rows["PWRD"], [d["text"] for d in FIX["PWRD"]["documents"]], [d["url"] for d in FIX["PWRD"]["documents"]])
# Perfect World: "US$4.04 for 208,028,535 issued and outstanding ordinary
# shares" plus options; left out "27,542,625 Class A ordinary shares and
# 13,416,800 Class B ordinary shares held by Perfect Human": 248,937,530 -
# 27,542,625 - 13,416,800 = 207,978,105, 0.02% from the fee table's count.
eq("Perfect World: the shares left out are Perfect Human's two holdings, 40,959,425", (c["excludedStated"], 27_542_625 + 13_416_800), (40.959, 40_959_425))
eq("Perfect World: raw 1.16, like for like 1.00", (c["rawRatio"], c["adjustedRatio"]), (1.16, 1.0))

c = perimeter.compare(rows["CHNG"], [d["text"] for d in FIX["CHNG"]["documents"]], [d["url"] for d in FIX["CHNG"]["documents"]])
# Emdeon: "115,778,777 shares of Class A common stock ... (including 24,565,195
# units ... and a corresponding number of shares of Class B common stock ...)"
# against our 115.903m: all equity, the units within the count, not added to
# it; plus options, RSUs and ESPP rights.
eq("Emdeon fee table: all equity with awards, the units inside the count not added to it", (c["perimeter"], c["feeShares"], c["adjustedRatio"]), (["all equity", "awards included"], 115.779, 1.0))
eq("the perimeter tool never changes a row", (rows["CHNG"]["sharesOut"], rows["CHNG"]["equityValue"]), (115.903, 2202.2))

# ── every row's count, read from the excerpts ────────────────────────────────

eq("the counts read, row by row (each excerpt gave the same reading as its whole document when it was cut)", {k: r.get("statedShares") for k, r in rows.items()},
   {"UGRO": 0.611, "NEFF": 23.849, "EDR": 307.864, "PFX": 54.474, "FSIC3": 291.127, "PLUR": 122.729, "SWLL": 55.359,
    "GOMO": 190.039, "PWRD": 248.938, "BBX16": 16.679, "BBX14": None, "QVC16": None, "CHNG": 115.903, "JAXB": 5.801, "CVC": 276.72, "LNY": 16.235})
eq("every row read is at the financials reader's version, 5", ({k: r["financialsReader"] for k, r in rows.items()}, filings.FINANCIALS_READER), ({k: 5 for k in rows}, 5))
eq("a row read at version 4 is due again", filings.needs_financials_reread({**FIX["SWLL"]["stored"], "financialsReader": 4}), True)

# ── the guard ────────────────────────────────────────────────────────────────

base = {k: {**FIX[k]["stored"]} for k in ("GOMO", "BBX14")}
cur = {k: copy.deepcopy(rows[k]) for k in ("GOMO", "BBX14")}
guard.protect(base, cur)
rev = [(r["from"], r["to"], r["cause"]) for r in cur["GOMO"].get("revisions") or [] if r["field"] == "sharesOut"]
eq("guard: Sungy's count moving from 80.653m to 190.039m is recorded, caused by the financials reader", rev, [(80.653, 190.039, "financialsReader 4 to 5")])
rev = [(r["from"], r["to"], r["cause"]) for r in cur["BBX14"].get("revisions") or [] if r["field"] == "sharesOut"]
eq("guard: BBX's one-class count withdrawn under the reader's version stands, and is recorded", (cur["BBX14"].get("sharesOut"), rev), (None, [(0.195, None, "financialsReader 4 to 5")]))
lost = {"BBX14": {**FIX["BBX14"]["stored"]}}
now = {"BBX14": {**copy.deepcopy(rows["BBX14"]), "financialsReader": 4}}
guard.protect(lost, now)
eq("guard: a count lost with no reader moving is put back", now["BBX14"]["sharesOut"], 0.195)

# ── the pure reader, on the filings' own wordings ────────────────────────────


def read(t: str, company: str | None = None, offer: float | None = None):
    r = parse.read_shares(t, company=company, offer=offer)
    return None if r is None else (r.get("count"), r.get("summed"), r.get("why"))


SUNGY = "As of March 31, 2015, the net book value per Share was US$0.60 based on 80,653,284 Class A ordinary shares and 109,386,066 Class B ordinary shares issued and outstanding as of that date."
SUNGY_TERMS = "Each Class A ordinary share, par value US$0.0001 per share of the Company (a “ Class A Share ”) and each Class B ordinary share, par value US$0.0001 per share of the Company (a “ Class B Share ” and, collectively with each Class A Share, the “ Shares ”), issued and outstanding immediately prior to the Effective Time (other than the Excluded Shares) shall be cancelled and cease to exist, in exchange for the right of the holder of such Share to receive US$0.81667 in cash without interest."
eq("two classes stated, their terms not: no count, and why", read(SUNGY, "Sungy Mobile Ltd", 0.8166),
   (None, None, "the filing states Class A, Class B outstanding and does not show that they receive the same consideration per share"))
eq("two classes stated, and the clause that converts each into the offer: the sum (Sungy)", read(SUNGY + " " + SUNGY_TERMS, "Sungy Mobile Ltd", 0.8166), (190.03935, ["Class A", "Class B"], None))
# Pluralsight: "each share of Class B common stock and Class C common stock
# ... will be cancelled and automatically converted into the right to receive
# cash in an amount equal to $0.0001", beside $20.26 for the Class A.
PS = ("As of the record date, there were 122,729,434 shares of Class A common stock outstanding, 12,097,175 shares of Class B Stock outstanding and 13,400,787 shares of Class C Stock outstanding. "
      "Each share of Class A common stock outstanding immediately prior to the effective time will be converted into the right to receive $20.26 in cash. "
      "Each share of Class B common stock and Class C common stock outstanding immediately prior to the effective time will be cancelled and automatically converted into the right to receive cash in an amount equal to $0.0001.")
eq("a class paid a nominal sum for its votes is left out, the rest counted (Pluralsight)", read(PS, "Pluralsight, Inc.", 20.26), (122.729434, ["Class A"], None))
# A class priced at a real sum of its own, with another class unpriced, gives no count.
ESH = ("There were 250,493,583 shares of Hospitality class A common stock outstanding and 250,493,583 shares of Hospitality class B common stock outstanding. "
       "Each share of Hospitality class B common stock will be converted into the right to receive $7.81 in cash.")
eq("a class priced apart, the others not priced: no count, and why", read(ESH, "ESH Hospitality, Inc.", 19.5),
   (None, None, "Class B receives $7.81 a share, not the offer's $19.5, and the filing does not price every class: the classes are not summed"))
# Neff's own wording: the Class B cancelled once it has been exchanged into the Class A.
NEFF = ("As of August 16, 2017, the Company had 8,897,535 shares of Class A Common Stock issued and outstanding and 14,951,625 shares of Class B Common Stock issued and outstanding, all of which will be cancelled as a result of the Exchanges. "
        "Each share of Class A Common Stock issued and outstanding immediately prior to the Effective Time, after giving effect to the Exchanges, shall be cancelled and automatically converted into the right to receive $25.00 in cash.")
eq("a class exchanged into the paid class before the merger is counted with it (Neff)", read(NEFF, "Neff Corp", 25.0), (23.84916, ["Class A", "Class B"], None))
# A class cancelled outright, without an exchange, is left out and named.
SW = ("There were 150,767,439 shares of Class A common stock and 94,131,279 shares of Class B common stock outstanding. "
      "Each share of Company Class A Common Stock issued and outstanding shall be converted into the right to receive $34.25 in cash. "
      "At the effective time, each share of Company Class B Common Stock shall be cancelled for no consideration.")
r = parse.read_shares(SW, company="Switch, Inc.", offer=34.25)
eq("a class cancelled for no consideration is left out and named (Switch's wording)", (r["count"], r["summed"], [(x["class"], x["why"].split(":")[0]) for x in r["excluded"]]), (150.767439, ["Class A"], [("Class B", "cancelled for no consideration")]))
eq("Old QVC: another company's classes are never the target's", read("the ownership information has been estimated based upon 137,008,911 shares of EXPE and 12,799,999 shares of Expedia class B common stock, in each case, outstanding on August 1, 2016.", "Old QVC Group, Inc."), None)
eq("BBX: the acquirer's classes are never the target's", read("As of November 3, 2016, approximately 73,637,880 shares of BFC’s Class A Common Stock, 15,002,233 shares of BFC’s Class B Common Stock, and 15,000 shares of BFC’s 5% Cumulative Preferred Stock were issued and outstanding.", "BBX CAPITAL CORP"), None)
eq("an authorized total is not the count; the count after 'of which' is (Inovalon's wording)", parse.parse_shares("The authorized capital stock of the Company consists of 750,000,000 shares of Company Class A Common Stock, of which 87,423,775 shares are issued and outstanding."), (None, None))
eq("an award's count beside the classes is not a class (VOXX)", read("As of the date of this Agreement, (i) 20,253,775 shares of Class A Common Stock were issued and outstanding; (ii) 2,260,954 shares of Class B Common Stock were issued and outstanding; (iii) no shares of Company Preferred Stock were issued and outstanding; and (iv) Company RSUs relating to 1,032,158 shares of Company Common Stock were outstanding. "
                                                                 "Each share of the Company’s Class A Common Stock, par value $0.01 per share (“Class A Common Stock”), and Class B Common Stock, par value $0.01 per share (“Class B Common Stock” and together with the Class A Common Stock, the “Company Common Stock”), issued and outstanding immediately prior to the effective time of the Merger, shall be cancelled and extinguished and automatically converted into and shall thereafter represent the right to receive an amount in cash equal to $7.50 per share of Company Common Stock.", "VOXX International Corp", 7.5),
   (22.514729, ["Class A", "Class B"], None))
eq("the classes' total beside them is passed over (MINDBODY)", read("There were 45,643,595 shares of our Class A common stock and 2,372,938 shares of our Class B common stock outstanding as of our Record Date, for a total of 48,016,533 shares of common stock outstanding. "
                                                                  "Each share of Class A common stock and Class B common stock outstanding immediately prior to the effective time will be cancelled and automatically converted into the right to receive $36.50 in cash.", "MINDBODY, Inc.", 36.5),
   (48.016533, ["Class A", "Class B"], None))
eq("an ADS count beside a class is never added to it", read("There were 80,653,284 Class A ordinary shares and 1,234,567 ADSs outstanding.", "Sungy Mobile Ltd"), (80.653284, None, None))
eq("a single class reads as before (Landry's)", read("there were 7,341,052 shares of common stock outstanding", "LANDRYS RESTAURANTS INC"), (7.341052, None, None))
# The award test is the share-count reader's (options, warrants, RSUs:
# _AWARD_INSTRUMENT), never the premium reader's cap or conversion price
# (_INSTRUMENT): VOXX's RSU count is an award's, its Class A count is not.
eq("an RSU's count is marked an award by the award pattern, not the premium reader's", [(m["n"], m["award"]) for m in parse._mentions("(i) 20,253,775 shares of Class A Common Stock were issued and outstanding; and (iv) Company RSUs relating to 1,032,158 shares of Company Common Stock were outstanding.")],
   [(20253775.0, False), (1032158.0, True)])

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
