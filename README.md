# l3vlup-skills

Free, open resources from [L3VLUP](https://www.l3vlup.com), the career platform
for finance and tech.

## Open finance data

Collected daily from official primary sources and published as plain JSON. No
API key, no signup, no rate limit. If it is useful to you, take it.

| File | What it is | Sources |
|---|---|---|
| `data/macro.auto.json` | Rates, inflation, unemployment and the 2s10s curve for the US, Eurozone and UK | US Treasury, BLS, ECB, ONS, Bank of England |
| `data/calendar.auto.json` | Upcoming economic releases and central-bank rate decisions | BLS, BEA, Federal Reserve, ECB, ONS, Bank of England |
| `data/deals.auto.json` | Announced M&A and private-equity deals, with values where the release discloses one | PR Newswire, GlobeNewswire |

Every record carries its source and a link to the original release. These
scripts collect and normalise; they do not republish anyone's journalism.

Rendered, with charts and commentary:
[Macro Chartbook](https://www.l3vlup.com/macro) ·
[Economic Calendar](https://www.l3vlup.com/macro/calendar) ·
[Deal Pulse](https://www.l3vlup.com/pulse)

### Using it

```bash
curl https://raw.githubusercontent.com/Surojitc/l3vlup-skills/main/data/macro.auto.json
```

Attribution is appreciated, not required. The underlying data belongs to the
statistical agencies that publish it; their terms are the binding ones.

### Running the collectors

Node 20, no dependencies:

```bash
npm run macro      # add FULL_HISTORY=1 to rebuild 26 years of Treasury data
npm run calendar
npm run deals
```

## Free-tier skills

The free tier of the L3VLUP skills library, organised by career path.

## Licence

Data files redistribute public-domain source data as-is. Everything else: MIT.
