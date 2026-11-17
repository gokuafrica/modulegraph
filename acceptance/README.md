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

`npm test` also runs `names-check`: none of the fixture's or the in-repo samples' names may appear in
`analyzer/src` or `ui/src` (checks excluded), so a fix can't just match the sample's words.
