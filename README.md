# modulegraph: review modules, not lines

Agent-written code is good enough at the line level, and linters and type checkers handle line-level slop.
What still needs a human is **structure**: which modules a change touches, what their contracts became, and
which flows feel it. modulegraph turns a diff (PR, branch/worktree, or uncommitted changes) into an
interactive graph of **entry point → modules → exit**, where every module shows only its inputs, outputs and
side effects.

**The analyzed code is never modified.** Modules are found from the code's own structure; everything else
lives in a config file kept outside the repo, which an agent can write.

**Pluggable analyzers.** The review pipeline (diffing, rules, brief, UI) is language-neutral. Language backends
turn code into the graph; today's TypeScript backend recognises **NestJS, Express, Fastify, KafkaJS, BullMQ,
node-cron, TypeORM, Prisma, Mongoose, axios and fetch** from `package.json`, so a NestJS service needs no
platform rules at all. See [docs/analyzers.md](docs/analyzers.md) for adding a framework (often just profile
data) or a language.

- **Flow view**: an API / gRPC / Kafka consumer / cron entry point → the modules it hands the request to → the
  response. Every level is module-sized: an endpoint shows the module(s) its controller calls (each node lists the
  modules it *uses* and every side effect below it), never the internals of one module. Data edges show what is
  passed (`identity` fetched once, then shared by Nationality, PersonalDetails and BirthInfo).
- **Drill in** on any module: its own entry, submodules and exit, recursively. A leaf shows its code diff.
- **Impact view, or "show references"**: right-click any module (or select it and press Shift+F12, or use its
  *references* link) to see who calls it, level by level, up to every entry point that reaches it, grouped when
  there are many (the 50-APIs case). Works for one operation or a whole module (*all of BirthInfo*), changed or not.
- **Now / before**: a changed flow has a *now | before* switch. *Before* draws the same flow as on the base branch,
  marking what the change removes and which guards it changes (`guard changes: now if (check.ok)`); recorded
  examples are hidden there, since they come from the new code.
- **Never lost**: the *Changes* bar above the graph lists every changed module, riskiest first; a click opens its
  impact view. Below it, the *path* shows how you got from that change to the current view
  (`impact BirthInfo.resolve → flow GET /v1/tax/… → flow TaxResidency.assess`); every step is one click back, and
  revisiting a step cuts the path there, so it never grows into a tree.
- **Changed modules highlighted**: modified / added / *changes inside*. Every node lists what it touches, one per
  row with the full name (`DB WRITE kyc_birth_info`, `OUTBOX birth_info.source_resolved`, `Kafka topic …`); `+` / `−`
  marks what the change adds or removes, dashed means via a submodule.
- **Review queue and checks**: contract changes sorted by risk, plus machine-checked rules (new side effects,
  table ownership, read endpoints that write, CI weakening, side effects the PR description doesn't mention).
- **Example data, one request throughout**: real inputs and outputs recorded by running a scenario against the
  code under review. Each scenario request is a case, and every module call it made is recorded as part of it, so
  the flow's input, each module (one `in` / `out` line, or *not called in this request*) and the response all show
  the same request, and drilling in or going up keeps it: a module three levels down shows the call its caller made
  with the same user and data. Shown as expandable object trees (like the browser devtools).
- **Big changes, function by function**: a changed module lists every changed function (its own method and inlined
  helpers, across files) before any code. The diff folds unchanged lines and marks the edited words. In the flow,
  new calls are outlined, removed calls stay as red ghosts, and changed guards are labelled.
- **Lazy analysis for large codebases** (`--lazy`): starts at the changed lines and analyzes only the 1–2 entry
  points that fit the PR. Everything else is analyzed when you open it (see below).
- **Browser Back works**: every view is a history entry, so the browser's Back/Forward and the in-app ← back
  are the same thing.

Design background: [docs/feasibility.md](docs/feasibility.md) · research: [docs/research-summary.md](docs/research-summary.md) ·
how it is applied: [docs/review-conventions.md](docs/review-conventions.md).

## Quick start

```bash
npm install
npm run demo        # regenerate demo graphs from this repo's git history, then start the UI
```

Open http://localhost:5173. `npm run dev` starts only the UI.

### Reviewing a change, and fixing it as you go

```bash
npm run review -- --project <service dir> --base main     # the branch checked out there, committed + uncommitted
npm run review -- --project <service dir> --head <branch> --base main   # a branch, read straight from git
npm run review -- --project <service dir> --pr 123        # a GitHub PR (needs gh)
```

`npm run review` analyzes lazily and keeps serving the review; open http://localhost:5173 (the UI opens the review
being served; there is no list to pick from). What it reads:

| You review | Head side | Base side |
|---|---|---|
| `--head <branch>` / `--pr <n>`, branch not checked out in `--project` | the branch's last commit, from git (no checkout) | merge-base with `--base` |
| the same, branch checked out in `--project` with uncommitted edits | the working tree: the PR **plus your local fixes** | merge-base |
| `--base main` alone | the branch checked out in `--project`, committed + uncommitted | merge-base |
| `--uncommitted` | the working tree | HEAD: only what isn't committed |

So finding a problem in a PR and fixing it locally needs no new mode: check the PR's branch out (`gh pr checkout`,
or a worktree), point `--project` at it, and the review includes your edits. The top bar says
`feature/x vs main + uncommitted edits`. `--committed` reads the commit only.

**Refresh.** Edit, save, and the top bar's button turns into `↻ code changed: refresh` (a cheap git check when the
window regains focus and every few seconds; nothing is analyzed until you click). A refresh:
- re-reads only the files whose text changed (new commits: only the files those commits touched); unchanged
  files are not parsed again and the type checker reuses them;
- keeps the base side's analysis as it is when the base didn't move (it doesn't, while you fix a PR);
- analyzes the new head to the same extent as before: the changed code, the seeds, and every flow, drill-in and
  caller list you had opened, so the view you are on stays open and only what the edit changed moves.

On the demos a refresh takes 0.4–1.5 s against 2–7 s for the first analysis. `npm run lazy-check` edits each demo
branch and checks the refreshed graph equals a full analysis of the edited code.

Analyze a change in any TypeScript service (the NestJS demo needs nothing but the project folder):

```bash
npm run analyze -- --project sample-nest-service --head feature/order-fraud-hold --base main
```

`--config` points at a service's profile, kept outside its repo; without it, the profile is found by package name:

```bash
C=configs/identity-profile-service
npm run analyze -- --project sample-service --config $C/modulegraph.config.json --uncommitted
npm run analyze -- --project sample-service --config $C/modulegraph.config.json --head feature/birthinfo-consent --base main --intent "…"
npm run analyze -- --project sample-service --config $C/modulegraph.config.json --pr 123        # needs gh
npm run analyze -- --project sample-service --config $C/modulegraph.config.json --head my-branch --check   # CI gate
npm run analyze -- --project sample-service --config $C/modulegraph.config.json --head my-branch --examples $C/scenario.ts
```

Each run writes `ui/public/graphs/<id>.json` (open it with `http://localhost:5173/#g=<id>`). It also writes
`<id>.brief.md`, the **review facts** as plain Markdown:
- the verdict (blocking or not);
- every contract change with the behaviour changes inside it (new and removed steps, changed guards) and the
  changed functions;
- entry points that now touch something different;
- grouped findings, owners and UI links.

Agents start from this file instead of the JSON, so even a small model with no context gets the facts right. It
only adds judgment. `--config` and `--intent` are optional: the profile is found in `configs/` by the service's
package name, and the intent comes from the PR or the branch's commit messages.

Any coding agent (Claude Code, Codex, Cursor, …) finds the procedure through [AGENTS.md](AGENTS.md).

### Lazy analysis: only what the review needs

On a large service, analyzing every flow up front wastes time and buries the change. With `--lazy`:

1. Changed lines are mapped to the operations and entry points that contain them. This includes changes reached
   through inlined helpers and changed types, found with the TypeScript reference index. Those are analyzed.
2. Callers are walked upward one level at a time, parsing only each caller's own function, until a few entry
   points are reached.
3. Entry points are ranked against the PR: new or changed entry points, words from the title and description,
   and distance from the change. The best 2 are analyzed fully (`--seeds <n>`). An agent that knows better can
   pick them with `--seed-entries "PUT /v1/…,kyc.recheck"`.
4. The rest is listed but not analyzed. With `--serve`, the UI analyzes more when you ask: *load* callers of a
   node, *all entry points* of a change, open a flow, or drill into a module. Each expansion is also written back
   to the JSON file, so the file always holds what has been explored.

```bash
npm run live            # live lazy analysis of all demos (BirthInfo, KYC, NestJS orders, NestJS birth info); open http://localhost:5173
npm run live -- birth   # just one of them: birthinfo | kyc | orders | birth
npm run review -- --project <dir> --head <branch>   # = analyze --lazy --serve
npm run lazy-check --workspace analyzer   # proves lazy == full on everything lazy analyzed
```

The top bar says `● live · 2 of 28 flows analyzed`. Unanalyzed parts are marked *flow not analyzed yet*,
*not analyzed yet: drill in*, or *⋯ callers not loaded · load*. On the demo, lazy mode builds 19 of 54 scopes
for the KYC change. Wall time is the same at this size, because loading the TypeScript program dominates. The
saving grows with the parts of a codebase a change doesn't reach.

## The demo

Code map, and where the before/after versions live: [sample-service/README.md](sample-service/README.md).

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
   *zoom out +* adds one caller level at a time; *all entry points* shows all 21, grouped. Wherever you go from
   there, the *BirthInfo.resolve* chip in the Changes bar brings you back.
3. **Checks**: BirthInfo now performs an outbox write that runs on 8 read-only endpoints, and the PR
   description never mentions it.
4. **A NestJS service** (`sample-nest-service`, "Orders (NestJS): hold high-risk orders for fraud review"): 13
   modules and 18 entry points (controllers, Kafka `@EventPattern` handlers, a gRPC method, BullMQ processors,
   `@OnEvent` listeners, `@Cron` jobs), found without any rules in its profile. Every flow crosses several modules:
   `POST /api/orders` → Orders → Customers, Pricing (→ Promotions, TaxApi), Shipping (→ CarrierApi), Inventory.
   The change touches 6 modules: a new Fraud module, held orders (guards changed on stock reservation and
   `orders.created`), a release endpoint and a fraud-desk consumer, a loyalty discount, tracking from carrier events
   instead of the carrier API, and two writes nobody mentioned (`order_views` on `GET /api/orders/:id`,
   `fraud_checks` on the read-only quote preview). Code map: [sample-nest-service/README.md](sample-nest-service/README.md).
5. **Enforcing document data, with examples** (`sample-birth-service`, `npm run live -- birth`): a NestJS
   service with document birth info (extracted, parts may be missing) and KYC birth info (what the user said).
   The change makes `POST /api/users/:userId/birth-info` reject a submission that contradicts the document.
   Drill into *BirthInfo.updateKycBirthInfo* and pick request 2 on the input: *u-1 submits ESP/Madrid*. The
   document read returns PRT/Porto, `BirthInfoVerifier.verify` returns `ok: false`, the save and the event say
   *not called in this request*, and the response throws the 422. Requests 3–7 cover a country-only document,
   no document data, and a place-only document. Code map: [sample-birth-service/README.md](sample-birth-service/README.md).
6. **A change spread over several files** (`feature/kyc-risk-tiers`, "KYC: risk tiers … (multi-file)"):
   - KycCheck.runCheck now uses a new helper file (`riskTier.ts`) and a new private `persist`, and gets a
     manual-review branch.
   - SanctionsScreening gains a retry and a score.
   - The nightly rescreen stops running checks inline and enqueues them instead.
   - Open *KycCheck.runCheck*, then *code changes ±*: 4 functions in 2 files. Open the cron
     `kyc-nightly-rescreen` flow to see the removed steps as ghosts.

## Setting up a new service (no code changes)

1. **Modules are discovered**: a class is a module when it has public methods and takes part in constructor
   injection (it is injected somewhere, or injects collaborators), or is a framework provider (Nest
   `@Injectable`). Its public methods are its operations. Framework adapters, chosen from `package.json`, know
   the entry points and side effects of common libraries.
2. **A profile describes the rest**, in `configs/<service>/` in this repo (or anywhere outside the service):
   - `modulegraph.config.json`:
     - `sinks`: in-house client methods that are DB reads/writes, outbox, Kafka, queue or HTTP, and how to name the table or topic;
     - `entryPoints` / `decoratorEntries`: in-house route, consumer and cron registrations (frameworks without an adapter);
     - `modules`: include/exclude, display names, optional declared contracts;
     - `owners`: path globs to teams (the repo's CODEOWNERS is also read);
     - `rules`: `fetchOnce`, `tableOwners`, review `budget`.

     Defaults are in [analyzer/src/config.ts](analyzer/src/config.ts).
   - `scenario.ts` (optional): drives the service, from whichever revision is under review, so real example
     calls get recorded. Wrap each request in `step('GET /users/u-1/birth-info', () => …)` so its module calls
     are recorded as one case. Services that need decorator metadata (NestJS, TypeORM) are compiled with
     TypeScript for this; see [configs/birth-info-service/scenario.ts](configs/birth-info-service/scenario.ts).
3. **An agent writes the profile**: the Claude Code skill [.claude/skills/module-review](.claude/skills/module-review/SKILL.md)
   reads the code and writes it. For languages without a backend it writes `modulegraph/v1` JSON directly
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
| `analyzer/` | CLI: `cli.ts`; `analyzers/` (backend contract `types.ts`, registry; `typescript/extract.ts` with `frameworks/` adapters); `compare.ts` + `compare-steps.ts` (base vs head, per-function and per-step deltas), `rules.ts` (guardrails), `brief.ts`, `lazy.ts` + `server.ts` (lazy analysis, live expansion); checks `framework-check.ts`, `lazy-check.ts`, `mentions-check.ts` |
| `ui/` | Vite + React + `@xyflow/react` + `elkjs` |
| `sample-service/` | demo microservice, an ordinary codebase with no modulegraph markers. Branches `feature/birthinfo-consent` and `feature/kyc-risk-tiers` hold the demo changes |
| `sample-nest-service/` | NestJS demo (order-service): REST, Kafka events, gRPC, BullMQ, cron, TypeORM. Branch `feature/order-fraud-hold` |
| `sample-birth-service/` | NestJS demo (birth-info-service): document vs KYC birth info, with a scenario. Branch `feature/enforce-document-birth-info` |
| `fixtures/frameworks/` | small Express + Prisma + KafkaJS + node-cron and Fastify + Mongoose + BullMQ services for `framework-check` |
| `configs/` | per-service profiles (config + scenario), kept outside the analyzed code |
| `docs/` | feasibility, research summary, review conventions |

## Limits of the MVP

TypeScript is the only static backend so far (other languages through the agent path, or a new backend).
Effects come from framework adapters and configured sink methods; in-house data access or raw SQL needs sink
rules in the profile. Module discovery relies on
constructor injection; codebases built from plain functions need `modules.include` in the profile. Dynamic
dispatch with several implementations is left unresolved. Example data needs a runnable scenario. No
persistence or auth: it is a local tool.
