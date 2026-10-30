# Feasibility: module-level review UI

**Verdict: buildable now with off-the-shelf parts.** No piece needs research-grade work.
The hard part is module extraction, and it becomes tractable once modules are *declared*
(a one-line `@module` tag) instead of inferred from scratch.

## Decisions

| Concern | Choice | Why | Rejected |
|---|---|---|---|
| Interchange format | One JSON document per analysis (`modulegraph/v1`, see [`schema/modulegraph.schema.json`](../schema/modulegraph.schema.json)) | Diffable, cacheable, any producer can write it (static analyzer, LLM agent, another language's analyzer) | Mermaid/PlantUML text: no room for side effects, change status or drill-in links |
| Renderer | **React Flow** (`@xyflow/react`) with custom node components | Nodes are real React components (side-effect chips, change badges), built-in pan/zoom/minimap, click handlers | Mermaid (static, weak interactivity), Cytoscape (styling via stylesheets, not components), raw D3 (too low-level for an MVP) |
| Layout | **ELK** (`elkjs`, layered algorithm, left→right) | Deterministic layered layout fits entry→modules→exit; handles fan-out/fan-in and 50+ nodes | dagre (unmaintained, weaker edge routing) |
| Extraction | **Static analysis with the TypeScript compiler (`ts-morph`)**, plus a Claude Code skill for enrichment and for codebases without conventions | Type checker resolves `this.birthInfo.resolve()` to its class across files, which gives reference indexing for free. Deterministic output is reproducible in CI | Pure-LLM extraction: non-deterministic, can't be trusted as the reviewer's source of truth |
| Diff source | `git diff` between a base and a head (branch, PR ref, or working tree); both sides are analyzed (base in a temporary `git worktree`) | Module status comes from comparing base and head *contracts*, not just changed lines. That is what surfaces "this change added a DB read" | Line-diff-only: can't tell a contract change from a refactor |

## Data model in one paragraph

A **module** is a class tagged `@module`. Its public methods are **operations**. Every
operation and every **entry point** (API route, gRPC method, Kafka consumer, cron job) is a
**scope**: an ordered list of **steps**. A step is either a call to another module's operation
or a direct **side effect** (DB read/write with table, outbox event, Kafka produce, external
HTTP call). Data edges between steps are recovered from local variables (`const identity =
await …; birthInfo.resolve(identity)`). Drill-in = open the callee's scope (recursive). Zoom-out =
walk the reverse call index from an operation up to every entry point. Calls into non-module
helpers are inlined, so internals stay hidden unless they are a module.

## Risks and how the MVP handles them

- **Dynamic dispatch / DI through interfaces**: resolved when an interface has exactly one implementing class. Otherwise the step is marked `unresolved`.
- **Side-effect detection on arbitrary codebases**: sinks are configured per repo (`modulegraph.config.json`: class + method → effect kind, which argument names the table/topic). The sample service uses a thin platform layer. Real codebases map their knex/prisma/kafkajs wrappers the same way.
- **Non-TypeScript services**: the schema is language-neutral. The analyzer is the only TS-specific part, and the Claude skill can emit the same schema for other languages.
