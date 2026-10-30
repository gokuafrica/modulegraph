# modulegraph: review modules, not lines

Agent-written code is good enough at the line level, and linters and type checkers handle line-level slop.
What still needs a human is **structure**: which modules a change touches, what their contracts became, and
which flows feel it. modulegraph turns a diff (PR, branch/worktree, or uncommitted changes) into an
interactive graph of **entry point → modules → exit**, where every module shows only its inputs, outputs and
side effects.

- **Flow view**: an API / gRPC / Kafka consumer / cron entry point → the chain of modules → the response.
  Data edges show what is passed (`identity` fetched once, then shared by Nationality, PersonalDetails and BirthInfo).
- **Drill in** on any module: its own entry, submodules and exit, recursively. A leaf shows its code diff.
- **Zoom out** from a changed module: callers level by level up to every entry point that reaches it,
  grouped when there are many (the 50-APIs case).
- **Changed modules highlighted**: modified / added / *changes inside*. Side-effect chips show
  `+outbox …` and `+db.read …` contract deltas on every node.
- **Review queue and guardrails**: contract changes sorted by risk, plus machine-checked rules (undeclared
  effects, table ownership, read endpoints that write, CI weakening, undisclosed effects).

Design background: [docs/feasibility.md](docs/feasibility.md) · research: [docs/research-summary.md](docs/research-summary.md) ·
how it is applied: [docs/review-conventions.md](docs/review-conventions.md).

## Quick start

```bash
npm install
npm run demo        # regenerate demo graphs from this repo's git history, then start the UI
```

Open http://localhost:5173. `npm run dev` starts only the UI.

Analyze your own change (any TypeScript service with `@module` tags, see below):

```bash
npm run analyze -- --project sample-service --uncommitted
npm run analyze -- --project sample-service --head feature/birthinfo-consent --base main --intent "…"
npm run analyze -- --project sample-service --pr 123          # needs gh
npm run analyze -- --project sample-service --head my-branch --check   # CI gate: exit 1 on new errors
```

Each run writes `ui/public/graphs/<id>.json` and adds it to the UI's selector.

## The demo

`sample-service/` is an identity/profile microservice with 16 modules and 28 entry points (REST, gRPC,
Kafka consumers, cron jobs):

- **Identity** extracts nationality and country/city of birth from user documents (DB + document-AI call).
- **Nationality**, **PersonalDetails** and **BirthInfo** use it. Orchestrators (ProfileAssembler, KycCheck,
  TaxResidency, TravelEligibility, …) fetch Identity **once** and pass it down; the `fetch-once` rule enforces this.
- Branch `feature/birthinfo-consent` changes **BirthInfo**: if the user gave consented birth data, use it and
  discard document data; otherwise fall back to documents. It was written the way an agent might: correct
  logic, plus an outbox write nobody asked for.

Things to try:

1. **One API flow where BirthInfo changed**: entry points → `GET /v1/users/:userId/profile`. Identity fans
   out to three modules; BirthInfo is amber with `+outbox` / `+read` chips; the read-only route shows
   *now writes*. Drill into BirthInfo: `BirthConsentStore` (added) → `if (consented)` outbox write /
   `unless (consented)` document fallback. Drill into `DocumentBirthExtractor` to see the line diff.
2. **BirthInfo used by many APIs**: click *BirthInfo.resolve* in the review queue. You start at the module;
   *zoom out +* adds one caller level at a time; *all entry points* shows all 21, grouped.
3. **Guardrails**: the change fails `--check`. BirthInfo's outbox write is undeclared, leaks into 8
   read-only endpoints, and isn't mentioned in the PR description.

## Declaring modules

```ts
/**
 * BirthInfo: the user's country and city of birth.   ← "Name: summary"
 * @module                                            ← this class is a module; public methods are its operations
 * @owner team-identity                               ← requested as reviewer when its contract changes
 * @effect db.read birth_info_consents                ← direct side effects (db.read|db.write|outbox|kafka|http)
 */
```

`<service>/modulegraph.config.json` maps your platform's classes to side effects and entry points
(`sinks`, `entryPoints`) and sets rules (`fetchOnce`, `tableOwners`, review `budget`). Defaults are in
[analyzer/src/config.ts](analyzer/src/config.ts). For codebases with no tags yet, or in other languages, the
Claude Code skill [.claude/skills/module-review](.claude/skills/module-review/SKILL.md) groups code into modules
and either proposes the tags or writes `modulegraph/v1` JSON directly
([schema](schema/modulegraph.schema.json), validated by `npm run validate --workspace analyzer -- <file>`).

## How it works

```
git diff (base…head)          ts-morph type checker                           React Flow + ELK
──────────────────── ──► analyzer: modules, operations, scopes ──► JSON ──► flow / drill-in / zoom-out
base + head sources        steps, data edges, side effects      modulegraph/v1    review queue, guardrails
                           base vs head → contract deltas, findings
```

- Both revisions are read straight from git objects (no checkout), so it works for any branch, PR ref or worktree.
- Calls are resolved with the TypeScript type checker (`this.birthInfo.resolve()` → `BirthInfoModule.resolve`),
  and that gives the reference index used for zoom-out. Interface calls resolve when there is a single implementation.
- Non-module helpers are inlined into their caller, so the graph only has module boundaries.
- Data edges come from local variable flow (`const identity = await …` → arguments), including `Promise.all`
  destructuring, loops (`⟳ each`), `if`/early-return guards (`if (consented)`, `unless (…)`).

## Layout

| Path | What |
|---|---|
| `schema/` | `modulegraph.ts` (types) and generated `modulegraph.schema.json` |
| `analyzer/` | CLI: `cli.ts`, `extract.ts` (ts-morph), `compare.ts` (base vs head), `rules.ts` (guardrails), `git.ts` |
| `ui/` | Vite + React + `@xyflow/react` + `elkjs` |
| `sample-service/` | demo microservice. Branch `feature/birthinfo-consent` holds the demo change |
| `docs/` | feasibility, research summary, review conventions |

## Limits of the MVP

TypeScript only for static extraction (other languages through the agent path). Effects are found through
configured sink methods, so raw SQL strings or ORMs need sink rules or `@effect` tags on repositories. Dynamic
dispatch with several implementations is left unresolved. No persistence or auth: it is a local tool.
