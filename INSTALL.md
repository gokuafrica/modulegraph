# Installing modulegraph

Written so a coding agent can do it end to end; a person can follow the same steps. If you are an agent that was
pointed at this file: do steps 1–4, then tell the user what step 5 says.

**Needs:** Node.js 20.19+ or 22.12+ (22 LTS or newer recommended), git, and npm (comes with Node). `gh` (GitHub CLI)
only for reviewing PRs by number. Windows, macOS and Linux. On macOS, git comes with the Command Line Tools
(`xcode-select --install`) or Homebrew (`brew install git`).

## 1. Get the code

Put it in its own folder, not inside a project and preferably not in a synced folder (OneDrive, Dropbox):

```bash
git clone https://github.com/gokuafrica/modulegraph ~/modulegraph
```

On Windows PowerShell, write `$HOME\modulegraph` instead of `~/modulegraph` (git doesn't expand `~` there).
Already there? Update it instead: `git -C ~/modulegraph pull`.

## 2. Run the setup

```bash
cd ~/modulegraph
npm run setup
```

It takes a minute or two the first time and ends with `modulegraph is ready.` It:
- installs the dependencies and builds the review UI;
- creates `~/.modulegraph/` (`configs/` for your services' profiles, `reviews/` for review output). It is private
  to the machine and not part of the repo;
- installs the **module-review** skill for Claude Code in every project (`~/.claude/skills/module-review/`) and
  writes the same procedure to `~/.modulegraph/module-review.md` for other agents;
- analyzes a bundled demo change to check that everything works.

If it fails, the last lines say why. The usual cause is an old Node version.

Re-running it is safe, and `git pull` followed by `npm run setup` is how you update. An existing
`~/.claude/skills/module-review` that setup did not create is left alone (`npm run setup -- --force-skill`
replaces it); `--no-skill` skips the skill entirely.

## 3. Other agents (skip for Claude Code)

Claude Code finds the skill by itself. Any other agent needs one line in its standing instructions. **Ask the user
before editing their agent's global instruction file.**

> For module-level review of a change (a PR, a branch or uncommitted work, "at module level" or "as a graph"),
> follow `~/.modulegraph/module-review.md`.

Where that line goes: Codex, `~/.codex/AGENTS.md`; Cursor, a User Rule in its settings; Gemini CLI,
`~/.gemini/GEMINI.md`; others, wherever they read standing instructions. Write the full path, with the home folder
spelled out.

## 4. Optional: a `modulegraph` command

Setup doesn't change your PATH. The command is `node ~/modulegraph/bin/modulegraph.mjs`; to type `modulegraph`
instead, add an alias:

```bash
# bash / zsh (~/.bashrc or ~/.zshrc)
alias modulegraph='node ~/modulegraph/bin/modulegraph.mjs'
```

```powershell
# PowerShell ($PROFILE)
function modulegraph { node "$HOME\modulegraph\bin\modulegraph.mjs" @args }
```

## 5. Using it

In any repository with a TypeScript service:

- **Ask the agent**: "review my branch at module level", "what does PR 123 affect?", "review my uncommitted
  changes as a graph". It runs the analyzer, reads the facts, writes a short brief and gives you a link.
- **Or look yourself**: in the service folder (the one with `package.json`), run `modulegraph review`. Your branch,
  committed and uncommitted, is compared with the repo's default branch, and the review opens in the browser.
  Edit code and click refresh in the review to see the change. `modulegraph review --head <branch>` reviews another
  branch without checking it out, `--pr <n>` a GitHub PR, `--uncommitted` only what isn't committed.
- `modulegraph open <id>` shows a saved review, live again while its code is on this machine; `modulegraph help` lists every option.
- **Finishing.** A review server stops by itself after 30 minutes with no requests (`--idle <minutes>`), or with
  `modulegraph stop`. Saved reviews stay in `~/.modulegraph/reviews/` (with your service's code in them) until you
  remove them: `modulegraph done <id>` (or the review page's **✓ done** button) removes one review, its PR ref and
  temp files; `modulegraph clean` removes reviews older than 14 days (`--older-than <days>`, `--dry-run` to see
  the list first).

**First review of a service.** NestJS, Express, Fastify, KafkaJS, BullMQ, node-cron, TypeORM, Prisma, Mongoose,
axios and fetch are recognised from `package.json`, so many services need nothing more. When a service uses
in-house platform code (its own DB client or message bus), the agent writes a profile for it in
`~/.modulegraph/configs/<service>/`, outside your repo. Your code is never modified.

**Teams.** Profiles are small JSON files. To share them, keep `~/.modulegraph/configs/` in a private git repository
of your own (clone it into that path), or point `MODULEGRAPH_HOME` at a shared folder.

**What stays on your machine.** Everything. The analyzer reads your repo through git and never uploads code or
reviews anywhere; the review server only accepts connections from this machine. Only `--pr` talks to GitHub,
through `gh`, to fetch the PR. A profile's optional `scenario.ts` runs your service's code locally to record example
calls, so only write one for code you trust, against test data.

**Try the demo first** (no repository of your own needed): `cd ~/modulegraph && npm run live`, then open
http://127.0.0.1:5174.

## Uninstalling

First, while modulegraph is still there, stop its servers and remove what it left in your repositories (the
`refs/modulegraph/*` refs `--pr` fetched, and `.modulegraph-tmp/` folders and git worktrees of runs that were
killed). `--older-than 0` also deletes every saved review; leave it out to keep them:

```bash
node ~/modulegraph/bin/modulegraph.mjs stop
node ~/modulegraph/bin/modulegraph.mjs clean --older-than 0 --dry-run    # see the list first
node ~/modulegraph/bin/modulegraph.mjs clean --older-than 0
```

Then delete `~/modulegraph`, `~/.modulegraph` (your profiles and reviews: keep it if you might come back) and
`~/.claude/skills/module-review`, and remove the line from step 3 if you added it. `tsx` (which runs the
analyzer) keeps a compile cache in the OS temp folder (`tsx-*` in `/tmp`, `$TMPDIR` or `%TEMP%`); delete it too
if you like, it is only a cache.
