#!/usr/bin/env python3
"""
The share count a transaction statement states is the shares outstanding.

    python3 scripts/__tests__/precedent-shares.test.py

WHY THIS EXISTS
---------------
Where the company facts carry no share count at announcement, a row takes the
count its transaction statement states (parse.parse_shares). On the October
2026 dry run that count was, for seven Chinese take-privates, the number of
shares their options would issue. A 13E-3 cover computes its filing fee on
"(c) the product of 1,480,457 shares issuable under all outstanding and
unexercised options", and that was the only count on Tarena's cover, so the
reader took it: $4.00 x 1.48m = $5.9m of equity value against a fee table
of $128.9m. Gridsum, SKY-MOBI, Dangdang, China Ming Yang, Sungy and Perfect
World read the same way, and so did Palm (the Series B preferred), Landry's
(one holder's options), SonicWall (a director's stake) and some thirty more.

The reader now passes over a count that the words between it and
"outstanding", or the words just before it, tie to an award, a security, a
holding or a sub-clause (parse.outstanding_count), and reads the count the
documents state for the shares themselves. Where they state none, there is
no count and no equity value: nothing is made up. The financials reader moves
to version 4, so every change is recorded by the guard as a revision with its
cause, and a row whose only change is the version is stamped without asking
EDGAR for anything.

Every figure below is worked by hand from the filing's own words, quoted in
the comment beside it. The fixtures are the passages of each deal's real
documents around every share count the reader sees and the filing-fee table,
as EDGAR serves them; the reading was checked to be the same over each
excerpt as over its whole document.
"""

from __future__ import annotations

import copy
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from precedent_transactions import database, filings, guard, parse  # noqa: E402

FIX = {d["key"]: d for d in json.loads((ROOT / "scripts" / "__tests__" / "fixtures" / "precedent-shares.json").read_text())}
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
asked: list[str] = []


def fixture_fetch(url, accept="text/html", tries=3, cap=None):
    asked.append(url)
    return DOCS[url]


def no_facts(url):
    raise AssertionError(f"company facts asked for: {url}")


def stored(key: str) -> dict:
    """The row as the dry run left it. A 404 marker is dated today, so the six months it waits are never up while the suite runs."""
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


rows = {k: reread(k) for k in FIX}

# ── the seven take-privates whose count was their options' ───────────────────

t = rows["TEDU"]
s = FIX["TEDU"]["stored"]
# Cover: "(c) the product of 1,480,457 shares issuable under all outstanding
# and unexercised options with per share exercise price lower than US$4.00".
# Proxy: "The calculations in the table below are based on 56,212,520 Shares
# outstanding as of May 19, 2021", stated three times; and the merger
# agreement's "48,912,726 Class A Ordinary Shares and 7,206,059 Class B
# Ordinary Shares are issued and outstanding", the classes "each ordinary
# share ... will be cancelled in exchange for the right to receive US$4.00".
# The classes, each judged on what it receives, are the count (the share
# class reader, version 5): 48,912,726 + 7,206,059 = 56,118,785.
eq("Tarena: the count stored was its options' 1,480,457 shares", (s["sharesOut"], s["statedSharesBasis"]), (1.48, "1,480,457 shares issuable under all outstanding"))
eq("Tarena: the count is its two classes, 48,912,726 + 7,206,059 = 56,118,785 shares", (t["sharesOut"], t["statedSharesBasis"], 48_912_726 + 7_206_059), (56.119, "48,912,726 Class A Ordinary Shares and 7,206,059 Class B Ordinary Shares are issued and outstanding", 56_118_785))
eq("Tarena: and the row says where it came from, and which classes", (t["sharesBasis"]["tag"], t["sharesBasis"]["classes"]), (filings.STATED, ["Class A", "Class B"]))
# $4.00 x 56.119m = $224.475m.
eq("Tarena: equity value $4.00 x 56.119m = $224.5m, not $5.9m", (t["equityValue"], s["sharesOut"] * s["offerPrice"]), (224.5, 5.92))
# Fee table: US$4.00 x 30,977,536 shares + US$4.00 x 242,539 RSUs + US$2.70 x
# 1,480,457 option shares = 123,910,144 + 970,156 + 3,997,233.90 =
# US$128,877,533.90, on the shares not rolled over. $224.5m / $129m = 1.74:
# above the fee, as a buyout of the minority is, inside the 0.5 to 12 the
# check allows; $5.9m / $129m = 0.05 was flagged.
eq("Tarena: the fee table's US$128,877,533.90 is in the cover", "US$128,877,533.90" in FIX["TEDU"]["documents"][0]["text"], True)
eq("Tarena: 30,977,536 x $4.00 + 242,539 x $4.00 + 1,480,457 x $2.70 = $128,877,533.90", round(30_977_536 * 4.0 + 242_539 * 4.0 + 1_480_457 * 2.70, 2), 128_877_533.9)
eq("Tarena: the equity value now agrees with the fee table, and the flag has gone", (t["dealValueRatio"], any("fee-table" in f for f in t["flags"])), (1.74, False))

g = rows["GSUM"]
# "1,093,879 shares issuable under all outstanding options with per share
# exercise price lower than $2.00"; "As of the date of this proxy statement,
# there are 35,051,107 Shares issued and outstanding (including Shares
# represented by ADSs)", and the merger agreement's "4,543,461 Class A
# Ordinary Shares and 30,469,307 Class B Ordinary Shares issued and
# outstanding", both classes cancelled for the same consideration: 4,543,461
# + 30,469,307 = 35,012,768. $2.00 x 35.013m = $70.026m, against the
# "Transactional Valuation* ... $ 56,775,002.82" of the cover: 1.23.
eq("Gridsum: 1,093,879 option shares give way to its two classes, 35,012,768 shares", (FIX["GSUM"]["stored"]["sharesOut"], g["sharesOut"], 4_543_461 + 30_469_307), (1.094, 35.013, 35_012_768))
eq("Gridsum: equity value $2.00 x 35.013m = $70.0m, 1.23 times the $56.8m fee table", (g["equityValue"], round(g["equityValue"] / 56.775002, 2)), (70.0, 1.23))

m = rows["MOBI"]
# "185,912 shares issuable under all outstanding options with per share
# exercise price lower than $0.275"; "As of the date of this proxy statement,
# we have 235,179,475 Shares issued and outstanding (including outstanding
# unvested Company Restricted Shares ...)". $0.275 x 235.179m = $64.674m,
# against "$35,854,055" on the cover (the shares not rolled over): 1.80.
eq("SKY-MOBI: 185,912 option shares give way to the 235,179,475 Shares issued and outstanding", (FIX["MOBI"]["stored"]["sharesOut"], m["sharesOut"]), (0.186, 235.179))
eq("SKY-MOBI: equity value $0.275 x 235.179m = $64.7m, 1.80 times the $35.9m fee table", (m["equityValue"], round(m["equityValue"] / 35.854055, 2)), (64.7, 1.8))
# SKY-MOBI's company facts were not found on the dry run: the six months'
# wait holds for them, not for the share count, which needs only the row's
# own documents.
eq("SKY-MOBI: the 404 marker stands and the company facts were not asked for, yet the count is read at this version", (m["companyFactsMissing"], m["financialsReader"]), (date.today().isoformat(), filings.FINANCIALS_READER))

d = rows["DANG"]
# "13,750,300 Class A common shares issuable under all outstanding and
# unexercised options"; "As of the date of this proxy statement, the Company
# has 411,434,410 Shares issued and outstanding". $1.34 x 411.434m =
# $551.322m, against "$ 555,644,880.50" on the cover: 0.99.
eq("Dangdang: 13,750,300 option shares give way to the 411,434,410 Shares issued and outstanding", (FIX["DANG"]["stored"]["sharesOut"], d["sharesOut"]), (13.75, 411.434))
eq("Dangdang: equity value $1.34 x 411.434m = $551.3m, 0.99 times the $555.6m fee table", (d["equityValue"], round(d["equityValue"] / 555.64488, 2)), (551.3, 0.99))

y = rows["MY"]
# "1,895,118 ordinary shares issuable under all outstanding options and
# share purchase right"; "As of the date of this proxy statement, there are
# 160,534,813 Shares issued and outstanding (including the Shares represented
# by ADSs)", six times in all. $2.51 x 160.535m = $402.943m, against
# "$228,227,250" on the cover (the shares not rolled over): 1.77.
eq("China Ming Yang: 1,895,118 option shares give way to the 160,534,813 Shares outstanding", (FIX["MY"]["stored"]["sharesOut"], y["sharesOut"]), (1.895, 160.535))
eq("China Ming Yang: equity value $2.51 x 160.535m = $402.9m, 1.77 times the $228.2m fee table", (y["equityValue"], round(y["equityValue"] / 228.22725, 2)), (402.9, 1.77))

# Sungy and Perfect World state their shares by class. Read one count at a
# time the reader took one class; it now sums the classes the merger pays the
# same price per share (precedent-share-classes.test.py works both by hand).
# Sungy: "based on 80,653,284 Class A ordinary shares and 109,386,066 Class B
# ordinary shares issued and outstanding as of that date"; 80,653,284 +
# 109,386,066 = 190,039,350, and $0.8166 x 190.039m = $155.186m.
o = rows["GOMO"]
eq("Sungy: 3,391,108 option shares give way to its two classes, 190,039,350 shares", (FIX["GOMO"]["stored"]["sharesOut"], o["sharesOut"]), (3.391, 190.039))
eq("Sungy: equity value $0.8166 x 190.039m = $155.2m", o["equityValue"], 155.2)
# Perfect World: "(i) 29,671,195 Class A Shares are issued and outstanding,
# ... (ii) 219,266,335 Class B Shares are issued and outstanding"; 29,671,195
# + 219,266,335 = 248,937,530, and $4.04 x 248.938m = $1,005.708m.
p = rows["PWRD"]
eq("Perfect World: 20,011,450 option shares give way to its two classes, 248,937,530 shares", (FIX["PWRD"]["stored"]["sharesOut"], p["sharesOut"]), (20.011, 248.938))
eq("Perfect World: equity value $4.04 x 248.938m = $1,005.7m", p["equityValue"], 1005.7)

# ── none stated, none made up ────────────────────────────────────────────────

j = rows["JMEI"]
# Jumei's only document read is the 13E-3 cover, whose only count is "393,218
# Class A Ordinary Shares issuable under all outstanding and unexercised
# options" (the fee table's "63,255,412 outstanding Class A Ordinary Shares"
# are the shares subject to the transaction, not the company's).
eq("Jumei: the cover states no count of the shares outstanding: no count", (j.get("statedShares"), j.get("sharesOut"), j.get("sharesBasis")), (None, None, None))
eq("Jumei: and no equity value, nor anything built on it", (j.get("equityValue"), j.get("ev"), j.get("evLtmEbitda")), (None, None, None))

# ── another security's count ─────────────────────────────────────────────────

a = rows["PALM"]
# "On the record date, there were 171,086,328 shares of Palm common stock
# outstanding, 325,000 shares of Series B Preferred Stock outstanding,
# convertible into 38,235,294 shares of Palm common stock". The preferred
# was the count; the common is. $5.70 x 171.086m = $975.190m.
eq("Palm: the 325,000 shares of Series B Preferred Stock give way to the 171,086,328 common", (FIX["PALM"]["stored"]["sharesOut"], a["sharesOut"]), (0.325, 171.086))
eq("Palm: the 38,235,294 the preferred converts into is not a count of the outstanding either", parse.parse_shares("325,000 shares of Series B Preferred Stock outstanding, convertible into 38,235,294 shares of Palm common stock, and 51,000 shares of Series C Preferred Stock outstanding")[0], None)
eq("Palm: equity value $5.70 x 171.086m = $975.2m", a["equityValue"], 975.2)

# ── the control: a row priced on the company facts' count ────────────────────

v = rows["VRNA"]
sv = FIX["VRNA"]["stored"]
# Verona's share count is the company facts' cover count; its stated count,
# "31,859,296 Company Shares (represented by 3,982,412 Company ADSs) were
# outstanding", still passes. Nothing to fetch and nothing changes but the
# version.
asked.clear()
again = stored("VRNA")
real = filings.fetch, filings.fetch_json
filings.fetch, filings.fetch_json = (lambda *a, **k: (_ for _ in ()).throw(AssertionError("fetched"))), no_facts
try:
    filings.reread_financials(again)
finally:
    filings.fetch, filings.fetch_json = real
eq("Verona: priced on the company facts' count, its row is stamped without a request", (again["financialsReader"], again["sharesOut"], again["sharesBasis"]), (filings.FINANCIALS_READER, sv["sharesOut"], sv["sharesBasis"]))
eq("Verona: and its stated count stands", (again["statedShares"], again["statedSharesBasis"]), (sv["statedShares"], sv["statedSharesBasis"]))
eq("Verona: the equity value is the one the row had", v["equityValue"], round(sv["offerPrice"] * sv["sharesOut"], 1))

# ── a document that cannot be fetched ────────────────────────────────────────

flaky = stored("TEDU")
real = filings.fetch
filings.fetch = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("HTTP Error 503: Service Unavailable"))
try:
    filings.reread_financials(flaky)
finally:
    filings.fetch = real
eq("a document that cannot be fetched leaves the row as it was, at its version, for the next run", (flaky["sharesOut"], flaky["financialsReader"], filings.needs_financials_reread(flaky)), (1.48, 3, True))

# ── the version and when a row is due ────────────────────────────────────────

eq("every row read is at the financials reader's version", {k: r["financialsReader"] for k, r in rows.items()}, {k: filings.FINANCIALS_READER for k in rows})
eq("a row read at this version is not due again", any(filings.needs_financials_reread(r) for r in rows.values()), False)
eq("a row read at version 3 is due", filings.needs_financials_reread({**FIX["VRNA"]["stored"], "financialsReader": 3}), True)
eq("the version moved from 3 to 4 and on to 5 (share classes), and the company facts' reading did not", (filings.FINANCIALS_READER, filings.FACTS_CONCEPTS), (5, 3))

# ── the guard ────────────────────────────────────────────────────────────────

base = {k: {**FIX[k]["stored"]} for k in ("TEDU", "JMEI")}
cur = {k: copy.deepcopy(rows[k]) for k in ("TEDU", "JMEI")}
report = guard.protect(base, cur)
rev = [(x["from"], x["to"], x["cause"]) for x in cur["TEDU"].get("revisions") or [] if x["field"] == "sharesOut"]
eq("guard: Tarena's count moving from 1.48m to 56.119m is recorded, caused by the financials reader", rev, [(1.48, 56.119, f"financialsReader 3 to {filings.FINANCIALS_READER}")])
rev = [(x["from"], x["to"], x["cause"]) for x in cur["JMEI"].get("revisions") or [] if x["field"] == "sharesOut"]
eq("guard: Jumei's options count withdrawn under the reader's version stands, and is recorded", (cur["JMEI"].get("sharesOut"), rev), (None, [(0.393, None, f"financialsReader 3 to {filings.FINANCIALS_READER}")]))
lost = {"JMEI": {**FIX["JMEI"]["stored"]}}
now = {"JMEI": {**copy.deepcopy(rows["JMEI"]), "financialsReader": 3}}
guard.protect(lost, now)
eq("guard: a count lost with no reader moving is put back", now["JMEI"]["sharesOut"], 0.393)

# ── every row's count, read from the excerpts ────────────────────────────────

eq("the counts read, row by row (each excerpt gave the same count as its whole document when it was cut)", {k: (r.get("statedShares")) for k, r in rows.items()},
   {"TEDU": 56.119, "GSUM": 35.013, "MOBI": 235.179, "DANG": 411.434, "MY": 160.535, "GOMO": 190.039, "PWRD": 248.938, "JMEI": None, "PALM": 171.086, "VRNA": 31.859})

# ── the pure reader, on the filings' own wordings ────────────────────────────


def count(phrase: str):
    return parse.parse_shares(phrase)[0]


# Each phrase is a count the dry run's rows stored, verbatim.
eq("an option count (Tarena)", count("1,480,457 shares issuable under all outstanding and unexercised options"), None)
eq("shares issuable on exercise (GAN)", count("3,523,393 Company Ordinary Shares were issuable upon the exercise of outstanding"), None)
eq("an award count (Targa)", count("285,409 shares of restricted stock units granted and outstanding"), None)
eq("shares reserved for a conversion (Envision)", count("13,789,728 shares of Class A Common Stock were reserved for issuance upon conversion of the outstanding"), None)
eq("an option over shares (Natural Resources USA)", count("The limited option to acquire up to 5,500,000 shares of Common Stock that is outstanding"), None)
eq("a holder's stake as a percentage (Delek in Alon)", count("33,691,292 shares of Alon common stock representing approximately 47% of the outstanding"), None)
eq("a rollover group's stake (Bancinsurance)", count("3,486,996 Common Shares, or approximately 67% of the outstanding"), None)
eq("a holding the directors held (Capital Gold)", count("CGC’s directors and executive officers, as of the record date for the special meeting, collectively held 449,196 shares of the then-outstanding CGC common stock"), None)
eq("half a parenthetical: the 'outstanding' is the RSAs' (Avadel)", count("97,403,364 Company Shares (145,300 of which were subject to outstanding"), None)
eq("treasury shares closing a sub-clause (Grindrod)", count("313,531 Shares held in treasury), and (ii) 475,515 Shares subject to outstanding"), None)
eq("shares counted with options and RSUs (TREX)", count("3,432,735 Shares, In-the-Money Company Stock Options and Company RSUs outstanding"), None)
eq("authorized preferred, none outstanding (TaskUs)", count("250,000,000 shares of Company Preferred Stock, none of which are issued or outstanding"), None)
# What is still a count of the shares outstanding.
eq("a count listed before the options and RSUs (TESCO)", count("46,756,282 Common Shares, 555,336 Options and 1,452,913 RSUs outstanding"), 46.756282)
eq("a parenthetical that closes is read past (Pike)", count("32,457,655 shares of common stock (including shares subject to restricted stock units and deferred stock units) issued and outstanding"), 32.457655)
eq("the ADSs in a parenthetical are not the count: the shares are (Verona)", count("31,859,296 Company Shares (represented by 3,982,412 Company ADSs) were outstanding"), 31.859296)
eq("holders of record are not a holding (Alumis)", count("47,222,419 shares of Alumis common stock, held by 67 holders of record, were outstanding"), 47.222419)
eq("all of the outstanding is the outstanding (Tiptree)", count("20,260,152 shares of our common stock, which represents all of our issued and outstanding"), 20.260152)
eq("an ADS count alone is never a count of shares", count("there were 3,982,412 Company ADSs outstanding"), None)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
