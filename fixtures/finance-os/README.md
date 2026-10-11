# Finance OS public fixtures

Small, invented examples that the public schemas in
`schemas/finance-os/` are tested against. Every company, transaction,
accession number and page reference here is fictitious and is marked as
such; nothing is drawn from a real filing or from any private source. They
exist so anyone implementing the contract can check their output against a
known-good document, and so the schemas cannot drift from what they claim.

| File | Shows |
|---|---|
| `precedent-ev.evidence.json` | All three lineage layers on one precedent transaction: sourced inputs, a calculation chain to EV/LTM EBITDA, a missing multiple kept as null, and rule, human and model decisions |
| `test-fixture.provider.json` | A provider profile with an approved rights review, the shape any data provider describes itself in |
