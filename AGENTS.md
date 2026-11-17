# Instructions for coding agents

This repo is **modulegraph**: module-level code review. Agents analyze a change and write a short reviewer brief.
People review it as an interactive graph.

- **Asked to install or set up modulegraph?** Follow [INSTALL.md](INSTALL.md) (in short: clone, `npm run setup`).
- **Asked to review a change, PR, branch or uncommitted work at module level?** Follow
  [.claude/skills/module-review/SKILL.md](.claude/skills/module-review/SKILL.md). It is plain Markdown and works
  for any agent (setup installs it for Claude Code in every project, and writes it to
  `~/.modulegraph/module-review.md` for others). In short: `node bin/modulegraph.mjs analyze --project <service dir>`
  (add `--head <branch>`, `--pr <n>` or `--uncommitted`), then read the printed `<id>.brief.md` and add the judgment.
  Afterwards, stop any server you started (`modulegraph stop <id>`) and offer the user `modulegraph done <id>` /
  `modulegraph clean` (step 3b of the skill); delete nothing without their yes.
- **Never modify the code being analyzed.** Per-service knowledge lives in the service's profile, in
  `~/.modulegraph/configs/<service>/` (the demo services' are in `configs/`).
- Backends and framework support: [docs/analyzers.md](docs/analyzers.md). The analyzer picks the language backend
  and the framework adapters (NestJS, Express, Fastify, KafkaJS, BullMQ, TypeORM, Prisma, …) from the project
  itself and prints which ones it used.
- Changing modulegraph itself: `npm run check` (types), `npm test` (intent matching, framework adapters vs
  hand-checked services, change grouping, lazy == full),
  `npm run validate --workspace analyzer -- <graph.json>` (schema). Before answering a field report, run the testers'
  own acceptance checks, `npm run accept:r2` and `npm run accept:r3` ([acceptance/](acceptance/README.md)), and never edit them to pass. The UI dev server is `npm run dev`
  (http://localhost:5173); `npm run setup` rebuilds the UI that `modulegraph review` serves.
