# Acceptance checks written by the testers

Checks here come from the people who test modulegraph on real services, not from its authors. They are the input:
**don't edit them to make a check pass.** If an expectation looks wrong, leave it failing and say why in the reply
to the field report.

## Round 2 (`round-2/`)

| File | What it is |
|---|---|
| `create-r2-fixture.mjs` | Writes `records-review-service`: a standalone NestJS 10 + TypeORM 0.3 + Jest 29 service shaped like the real one (29 handler-map consumers, 7 argv jobs, in-house Kafka and outbox wrappers), as a git repo with `main` and `fix/conclude-review-row-scope`, and its own `npm install`. It refuses to write inside a git repo. |
| `accept-r2.mjs` | 33 checks, each tagged with its field-report item (R2-1 …): four `analyze` runs, the UI in a headless installed Edge or Chrome, and a fresh clone running `setup` + `npm test`. Exit 0 only when all pass. |
| `red-baseline-3b811d5.txt` | What it printed on `3b811d5`, before the round-2 fixes (9/33). |

Run it on this checkout (makes the fixture in the OS temp folder the first time, about a minute):

```bash
npm run accept:r2
```

With the fresh-clone check (R2-7), against a pushed `main` or a local clone source:

```bash
npm run accept:r2 -- --fresh-clone https://github.com/gokuafrica/modulegraph.git
```

`MODULEGRAPH_R2_FIXTURE=<dir>` puts the fixture elsewhere (outside any repo). The fixture must never become a
workspace of this repo: npm would hoist its packages, which is exactly what hid R2-1.

## Round 3 (`round-3/`)

| File | What it is |
|---|---|
| `create-r3-fixture.mjs` | The round-2 service plus the shapes the real service still had: jobs whose start hook calls `run()`, HTTP clients whose URL comes from a field, a local or `request({ url })`, a vendor SDK and an SFTP client (network I/O no adapter knows), entity arrays saved in a transaction, a `queryRunner` transaction over two data sources, a facade that calls a helper first. Same rules: outside any repo, its own `npm install`. |
| `accept-r3.mjs` | 72 checks: every round-2 check (regressions), the R3 items, and the invariants on every review it makes. The "with profile" runs use the profile the first run's brief suggests, applied as-is. |
| `invariants.mjs` | I1-I5: properties of any correct review, with no names in them. `npm test` runs them over every sample and fixture in this repo too (`invariants-check`). |
| `red-baseline-3275457.txt` | What it printed on `3275457`, before the round-3 fixes (47/72). |

```bash
npm run accept:r3
```

```bash
npm run accept:r3 -- --fresh-clone https://github.com/gokuafrica/modulegraph.git
```

`MODULEGRAPH_R3_FIXTURE=<dir>` puts its fixture elsewhere (outside any repo). Both rounds run from
`acceptance/run.mjs <round>`.

`npm test` also runs `names-check`: none of the fixture's or the in-repo samples' names may appear in
`analyzer/src` or `ui/src` (checks excluded), so a fix can't just match the sample's words.
