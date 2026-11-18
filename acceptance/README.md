# Acceptance checks written by the testers

Checks here come from the people who test modulegraph on real services, not from its authors. They are the input:
**don't edit them to make a check pass.** If an expectation looks wrong, leave it failing and say why in the reply
to the field report.

Round 2's kit (`round-2/`) is retired: round 3 contains all its checks. It is in git history (`3275457`).

## Round 3 (`round-3/`)

| File | What it is |
|---|---|
| `create-r3-fixture.mjs` | The round-2 service plus the shapes the real service still had: jobs whose start hook calls `run()`, HTTP clients whose URL comes from a field, a local or `request({ url })`, a vendor SDK and an SFTP client (network I/O no adapter knows), entity arrays saved in a transaction, a `queryRunner` transaction over two data sources, a facade that calls a helper first. Same rules: outside any repo, its own `npm install`. |
| `accept-r3.mjs` | 72 checks: every round-2 check (regressions), the R3 items, and the invariants on every review it makes. The "with profile" runs use the profile the first run's brief suggests, applied as-is. |
| `invariants.mjs` | Round 4's copy (I1-I5, I7, I9), as round 4 says it replaces round 3's. |
| `red-baseline-3275457.txt` | What it printed on `3275457`, before the round-3 fixes (47/72). |

```bash
npm run accept:r3
```

```bash
npm run accept:r3 -- --fresh-clone https://github.com/gokuafrica/modulegraph.git
```

`MODULEGRAPH_R3_FIXTURE=<dir>` puts its fixture elsewhere (outside any repo). The fixture must never become a
workspace of this repo: npm would hoist its packages, which is what hid R2-1.

## Round 4 (`round-4/`)

| File | What it is |
|---|---|
| `create-r4-fixture.mjs` | Round 3's service plus the round-4 shapes, copied from the real code with names changed: callbacks handed to a helper that stores them and runs them later, two query runners committed separately, a `transaction(cb)` whose callback also writes through its own repository, strategy steps injected as a list, `retry(fn)`, an abstract class bound with `useClass`, a URL signer next to an HTTP client, URLs from a config object's property and from destructuring, a read that locks its rows; since bug note 1, status handlers in a Map and a hook list filled at run time. |
| `accept-r4.mjs` | 63 checks (bug note 1 added B1-B3), about a minute (`--only R4-2` for one item): two runs (no profile, lazy; then the suggested profile, full, `--explain`), the invariants on both, the call accounting, one browser page with `--ui`. |
| `accounting.mjs` | An independent list, from the TypeScript parser only, of every call through a value and every function literal handed to a call: each must be in `--explain` as `followed` or a `gap`. |
| `invariants.mjs` | I1-I5, I7, I9. `npm test` runs them over every sample and fixture in this repo (`invariants-check`), and every review checks the same properties on itself (`analyzer/src/invariants.ts`). |
| `red-baseline-b4776f4.txt` | What it printed on `b4776f4`, before the bug-note-1 fixes (48/63). Round 4's own red run (30/47 on `4b292fb`) is in [docs/field-report/round-4](../docs/field-report/round-4/). |

```bash
npm run accept:r4
```

`MODULEGRAPH_R4_FIXTURE=<dir>` puts its fixture elsewhere. Both rounds run from `acceptance/run.mjs <round>`.

`npm test` also runs `names-check`: none of the fixture's or the in-repo samples' names may appear in
`analyzer/src` or `ui/src` (checks excluded), so a fix can't just match the sample's words.
