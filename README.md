# modulegraph: review modules, not lines

Agent-written code is good enough at the line level, and linters and type checkers handle line-level slop.
What still needs a human is **structure**: which modules a change touches, what their contracts became, and
which flows feel it. modulegraph turns a diff (PR, branch/worktree, or uncommitted changes) into an
interactive graph of **entry point → modules → exit**, where every module shows only its inputs, outputs and
side effects.

**The analyzed code is never modified.** Modules are found from the code's own structure; everything else
lives in a config file kept outside the repo, which an agent can write.

**Pluggable analyzers.** The review pipeline (diffing, rules, brief, UI) is language-neutral. Language backends
turn code into the graph; today's TypeScript backend recognises **NestJS (with its request pipeline, CQRS,
GraphQL and WebSockets), Express, Fastify, KafkaJS, BullMQ, node-cron, TypeORM, Prisma, Mongoose, axios and
fetch** from `package.json`, so a NestJS service needs no platform rules at all. When it can't see something
(packages not installed, changed code in no flow it knows), the review says the analysis is **incomplete** instead
of reporting nothing. See [docs/analyzers.md](docs/analyzers.md) for adding a framework (often just profile data)
or a language.

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

## Install

Tell your coding agent (Claude Code, Codex, Cursor, …):

> Install modulegraph by following https://github.com/gokuafrica/modulegraph/blob/main/INSTALL.md

Or by hand (Node 20.6+ and git):

```bash
git clone https://github.com/gokuafrica/modulegraph ~/modulegraph
cd ~/modulegraph && npm run setup
```

Setup installs the dependencies, builds the UI, installs the **module-review** skill for agents and checks that
everything works on a bundled demo. [INSTALL.md](INSTALL.md) has the details: other agents, a `modulegraph` alias,
updating and uninstalling.

## Use it on your code

- **Ask your agent**: "review my branch at module level", "what does PR 123 affect?". It runs the analyzer,
  writes a short brief with the 1–3 decisions only you can make, and links to the graph.
- **Or open the graph yourself**, in the service folder: `node ~/modulegraph/bin/modulegraph.mjs review` (or
  `modulegraph review` with the alias). It compares your branch, committed and uncommitted, with the repo's default
  branch and opens the review in your browser.

**Your code stays yours.** The analyzed repo is never modified, and nothing leaves your machine: the analyzer reads
through git, the review server accepts connections from this machine only, and only `--pr` talks to GitHub (via
`gh`). Profiles and reviews live in `~/.modulegraph/` (`configs/`, `reviews/`), outside both your repo and this one.

## Quick start (the demos)

```bash
npm run setup       # once
npm run live        # the birth-info demo, served live: open http://127.0.0.1:5174
npm run demo        # regenerate the shipped demo graphs (ui/public/graphs) from this repo's git history, then start the UI dev server
```

`npm run dev` starts only the UI dev server (http://localhost:5173), for working on the UI.

### Reviewing a change, and fixing it as you go

```bash
modulegraph review                        # the branch checked out here, committed + uncommitted, vs the default branch
modulegraph review --head <branch>        # a branch, read straight from git (no checkout)
modulegraph review --pr 123               # a GitHub PR (needs gh)
modulegraph review --base release/2.3     # against another branch
```

(`modulegraph` is `node <modulegraph folder>/bin/modulegraph.mjs`; run it in the service folder or pass
`--project <dir>`.) `review` analyzes lazily, serves the review on http://127.0.0.1:5174 and opens it. What it
reads:

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

### Ending a review

A review server holds the analyzed code (both revisions) in memory, and every review is saved in
`~/.modulegraph/reviews/` with the service's source code in its JSON. Neither lasts forever:

- **Servers stop by themselves** after 30 minutes with no requests (`--idle <minutes>`, `0` = never; the startup
  line says so). An open review tab asks every 5 s while it is visible, so that means nobody is looking. A server
  also stops when the command that started it is killed, on every OS, and `npm run live`'s router takes its demo
  servers down with it. When a server has stopped, an open tab says so and keeps showing what was analyzed.
- **`modulegraph stop [<id>]`** stops the server serving `<id>` (no id: every modulegraph server). It deletes nothing.
- **`modulegraph done [<id>]`**, or the review page's **✓ done** button: the review is finished. It stops the
  server and deletes the review's graph, brief and `index.json` entry, the `refs/modulegraph/pr-<n>` ref `--pr`
  fetched (unless another saved review uses it), and scenario temp folders that a killed run left in the repo. No
  id: the one review being served. `--keep-brief` keeps `<id>.brief.md`; `--dry-run` only lists.
  The brief goes too by default: it is derived (re-run the analyzer to get it back, the commits are still there),
  what mattered in it is in the agent's summary or the PR by then, and keeping it would mean reviews still pile up.
- **`modulegraph clean [--older-than <days>] [--dry-run]`** removes reviews older than 14 days that no server is
  serving, index entries without files, and, in every repo modulegraph has read (recorded in
  `~/.modulegraph/repos.json`), `refs/modulegraph/*` refs no remaining review uses and `.modulegraph-tmp/<pid>/`
  folders (with their git worktrees) of processes that are gone. It lists everything it removes.

In the reviewed repo these touch only modulegraph's own things: `refs/modulegraph/*`, `.modulegraph-tmp/<pid>/`
of dead runs, and the worktrees registered there (removed one by one: never a blanket `git worktree prune`, which
would also drop your own worktrees whose folder is missing). Shipped demo graphs (`ui/public/graphs/`) are never
deleted. Not covered: the TypeScript compile cache that `tsx` keeps in the OS temp folder (`tsx-*`); it belongs to
tsx and is safe to delete. A graph written with `--out <file>` is yours to delete, unless you end it while it is
being served.

`modulegraph analyze` takes the same options, writes the review and exits: what agents run. On the NestJS demo,
from this folder (it needs nothing but the project folder):

```bash
npm run analyze -- --project sample-nest-service --head feature/order-fraud-hold --base main
```

`--config` points at a service's profile, kept outside its repo; without it, the profile is found by package name
in `~/.modulegraph/configs/`, then in this repo's `configs/` (the demos'):

```bash
C=configs/identity-profile-service
npm run analyze -- --project sample-service --config $C/modulegraph.config.json --uncommitted
npm run analyze -- --project sample-service --config $C/modulegraph.config.json --head feature/birthinfo-consent --base main --intent "…"
npm run analyze -- --project sample-service --config $C/modulegraph.config.json --pr 123        # needs gh
npm run analyze -- --project sample-service --config $C/modulegraph.config.json --head my-branch --check   # CI gate
npm run analyze -- --project sample-service --config $C/modulegraph.config.json --head my-branch --examples $C/scenario.ts
```

Each run writes `~/.modulegraph/reviews/<id>.json`, also for the demo services and `npm run live` (only `npm run demo`
rewrites the shipped graphs in `ui/public/graphs/`, which are kept in git); `modulegraph open <id>` shows it. It also writes `<id>.brief.md`, the **review facts** as plain Markdown:
- the verdict: blocking, not blocked, or **incomplete** (what the analysis could not see, and what to do about it);
- access-control changes: guards, middleware or auth metadata added, removed or edited, with every entry point
  behind them;
- every contract change with the behaviour changes inside it (new and removed steps, changed guards) and the
  changed functions;
- entry points that now touch something different;
- grouped findings, owners and UI links.

Agents start from this file instead of the JSON, so even a small model with no context gets the facts right. It
only adds judgment. `--config` and `--intent` are optional: the profile is found by the service's package name,
and the intent comes from the PR or the branch's commit messages.

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
npm run live            # live review of the birth-info demo (sample-birth-service, the small one); open http://127.0.0.1:5174
npm run live -- all     # every live demo (view them with npm run dev: http://localhost:5173); or one: birth | residency | birthinfo | kyc | orders
modulegraph review --head <branch>   # = analyze --lazy --serve --open
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
5. **Enforcing document data, with examples** (`sample-birth-service`, `npm run live`): a NestJS
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
2. **A profile describes the rest**, in `~/.modulegraph/configs/<service>/` (the demos' are in this repo's
   `configs/`), never in the service:
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
| `analyzer/` | CLI: `cli.ts`; `analyzers/` (backend contract `types.ts`, registry; `typescript/extract.ts` with `frameworks/` adapters); `compare.ts` + `compare-steps.ts` (base vs head, per-function and per-step deltas), `rules.ts` (guardrails), `coverage.ts` (what makes a review incomplete), `brief.ts`, `lazy.ts` + `server.ts` (lazy analysis, live expansion); `servers.ts` (idle shutdown, server registry), `cleanup.ts` + `end.ts` (`stop`, `done`, `clean`); checks `framework-check.ts`, `regression-check.ts`, `lazy-check.ts`, `changes-check.ts`, `mentions-check.ts`, `lifecycle-check.ts` |
| `ui/` | Vite + React + `@xyflow/react` + `elkjs` |
| `sample-service/` | demo microservice, an ordinary codebase with no modulegraph markers. Branches `feature/birthinfo-consent` and `feature/kyc-risk-tiers` hold the demo changes |
| `sample-nest-service/` | NestJS demo (order-service): REST, Kafka events, gRPC, BullMQ, cron, TypeORM. Branch `feature/order-fraud-hold` |
| `sample-birth-service/` | NestJS demo (birth-info-service): document vs KYC birth info, with a scenario. Branch `feature/enforce-document-birth-info` |
| `fixtures/frameworks/` | small Express + Prisma + KafkaJS + node-cron and Fastify + Mongoose + BullMQ services, and `nest/` (request pipeline, CQRS, custom providers, GraphQL, WebSockets, …) for `framework-check` and `regression-check` |
| `configs/` | the demo services' profiles (config + scenario); yours go in `~/.modulegraph/configs/` |
| `bin/`, `scripts/` | the `modulegraph` command; `setup.mjs` (install, build the UI, install the skill, self-check) |
| `docs/` | feasibility, research summary, review conventions |

## Limits of the MVP

TypeScript is the only static backend so far (other languages through the agent path, or a new backend).
Effects come from framework adapters and configured sink methods; in-house data access, and libraries without an
adapter yet (AWS SDK, Redis, RabbitMQ, SQS), need sink rules in the profile. Raw SQL through TypeORM's `query()`
is classified by its statement; SQL that isn't a literal counts as a write. The analyzer needs the service's
dependencies installed: without them the review says it is incomplete rather than guessing. Module discovery
relies on constructor injection; codebases built from plain functions need `modules.include` in the profile.
Dynamic dispatch with several implementations is left unresolved unless dependency injection binds one (Nest
`providers`). Code in an Nx `libs/` folder outside `--project` is not analyzed. More in
[docs/analyzers.md](docs/analyzers.md#known-limits). Example data needs a runnable scenario. No persistence or
auth: it is a local tool, and the review server accepts connections from this machine only.
