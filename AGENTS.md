# Instructions for coding agents

This repo is **modulegraph**: module-level code review. Agents analyze a change and write a short reviewer brief.
People review it as an interactive graph.

- **Asked to review a change, PR, branch or uncommitted work at module level?** Follow
  [.claude/skills/module-review/SKILL.md](.claude/skills/module-review/SKILL.md). It is plain Markdown and works
  for any agent (Claude Code loads it as a skill automatically). In short:
  `npm run analyze -- --project <service dir> --head <branch> --base main` (or `--uncommitted`), then read the
  printed `<id>.brief.md` and add the judgment.
- **Never modify the code being analyzed.** Per-service knowledge lives in `configs/<service>/`.
- Changing modulegraph itself: `npm run check` (types), `npm run lazy-check --workspace analyzer` (lazy == full),
  `npm run validate --workspace analyzer -- <graph.json>` (schema). The UI is `npm run dev` (http://localhost:5173).
