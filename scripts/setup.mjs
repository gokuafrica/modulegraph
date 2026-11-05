#!/usr/bin/env node
/**
 * Sets modulegraph up on this machine. Safe to run again: after `git pull`, it is also the update.
 *
 *   node scripts/setup.mjs [--no-skill] [--force-skill]
 *
 * 1. checks Node and git;
 * 2. installs the dependencies and builds the review UI;
 * 3. creates local branches for the demo changes (a fresh clone has them only as origin/feature/…);
 * 4. creates your modulegraph home, ~/.modulegraph (MODULEGRAPH_HOME moves it): configs/ for your services'
 *    profiles, reviews/ for the review graphs and briefs. Nothing in it is part of this repo;
 * 5. installs the module-review skill for agents: ~/.claude/skills/module-review/ (Claude Code, every project) and
 *    ~/.modulegraph/module-review.md (any other agent: point it at that file);
 * 6. checks it works by analyzing the bundled demo change.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flags = new Set(process.argv.slice(2));
const home = resolve(process.env.MODULEGRAPH_HOME ?? join(homedir(), '.modulegraph'));
const skillsDir = resolve(process.env.MODULEGRAPH_SKILLS_DIR ?? join(homedir(), '.claude', 'skills'));
const MARKER = '<!-- installed by modulegraph setup: re-run it to update; edits here are overwritten -->';
// main too: a CI checkout of a pull request has no local main.
const DEMO_BRANCHES = [
  'main',
  'feature/birthinfo-consent',
  'feature/kyc-risk-tiers',
  'feature/order-fraud-hold',
  'feature/enforce-document-birth-info',
  'feature/residency-declaration',
];

const step = (n, text) => console.log(`\n[${n}/6] ${text}`);
const fail = (text) => {
  console.error(`\nsetup failed: ${text}`);
  process.exit(1);
};
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: root, stdio: opts.quiet ? 'pipe' : 'inherit', encoding: 'utf8', ...opts });
// npm is a script on Windows (npm.cmd), which needs a shell; the arguments here are fixed, so one command line is safe.
const npm = (line) => spawnSync(`npm ${line}`, { cwd: root, stdio: 'inherit', shell: true });

// 1. Node and git
step(1, 'checking Node and git');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 6)) fail(`Node ${process.versions.node} is too old: modulegraph needs Node 20.6 or newer (22 LTS recommended).`);
const gitVersion = run('git', ['--version'], { quiet: true });
if (gitVersion.status !== 0) fail('git was not found on PATH. Install git and run setup again.');
console.log(`  Node ${process.versions.node}, ${gitVersion.stdout.trim()}`);

// 2. dependencies and the UI
step(2, 'installing dependencies and building the review UI (a minute or two the first time)');
if (npm('install --no-audit --no-fund').status !== 0) fail('npm install failed (output above).');
if (npm('run build --workspace ui').status !== 0) fail('building the UI failed (output above).');

// 3. demo branches
step(3, 'making the demo changes available');
const has = (ref) => run('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { quiet: true }).status === 0;
let missing = 0;
for (const branch of DEMO_BRANCHES) {
  if (has(`refs/heads/${branch}`)) continue;
  if (has(`refs/remotes/origin/${branch}`)) {
    run('git', ['branch', '--quiet', branch, `origin/${branch}`], { quiet: true });
    console.log(`  created ${branch} from origin/${branch}`);
  } else missing++;
}
if (missing) console.log(`  ${missing} demo branch(es) not found: the demos that use them won't work (your own reviews are not affected)`);
else console.log('  all demo branches present');

// 4. modulegraph home
step(4, `creating your modulegraph home: ${home}`);
for (const dir of ['configs', 'reviews']) mkdirSync(join(home, dir), { recursive: true });
const readme = join(home, 'README.md');
if (!existsSync(readme)) {
  writeFileSync(readme, `# modulegraph home

Private to this machine; not part of the modulegraph repo, and updating modulegraph never touches it.

- \`configs/<service>/modulegraph.config.json\`: what modulegraph knows about one of your services (its profile),
  found by the service's package name. Optional \`scenario.ts\` next to it records example calls.
  Templates: ${join(root, 'configs').replace(/\\/g, '/')}
- \`reviews/\`: review graphs (\`<id>.json\`) and briefs (\`<id>.brief.md\`).
- \`module-review.md\`: the review procedure for agents (rewritten by setup).

The modulegraph tool itself: ${root.replace(/\\/g, '/')}
`);
}

// 5. the skill
step(5, 'installing the module-review skill for agents');
const source = readFileSync(join(root, '.claude/skills/module-review/SKILL.md'), 'utf8');
const rootPath = root.replace(/\\/g, '/');
const rendered = source
  .replace(/<!-- modulegraph-path -->[\s\S]*?<!-- \/modulegraph-path -->/g, `\`${rootPath}\``)
  .replace(/^(---\n[\s\S]*?\n---\n)/, `$1\n${MARKER}\n`);
writeFileSync(join(home, 'module-review.md'), rendered);
console.log(`  any agent: ${join(home, 'module-review.md')}`);
if (flags.has('--no-skill')) console.log('  Claude Code skill: skipped (--no-skill)');
else {
  const target = join(skillsDir, 'module-review', 'SKILL.md');
  const ours = !existsSync(target) || readFileSync(target, 'utf8').includes(MARKER);
  if (!ours && !flags.has('--force-skill')) {
    console.log(`  Claude Code skill: ${target} exists and was not installed by modulegraph; left as it is (--force-skill replaces it)`);
  } else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, rendered);
    console.log(`  Claude Code (every project): ${target}`);
  }
}

// 6. smoke test
step(6, 'checking it works on the bundled demo change');
const out = mkdtempSync(join(tmpdir(), 'modulegraph-setup-'));
if (has('refs/heads/feature/enforce-document-birth-info')) {
  const check = run(process.execPath, [join(root, 'bin/modulegraph.mjs'), 'analyze', '--project', join(root, 'sample-birth-service'),
    '--head', 'feature/enforce-document-birth-info', '--base', 'main', '--no-examples', '--out', join(out, 'check.json')], { quiet: true });
  const text = `${check.stdout ?? ''}${check.stderr ?? ''}`;
  if (check.status !== 0 || !/changes \(riskiest first\): 1,/.test(text)) {
    console.error(text);
    fail('the demo analysis did not give the expected result (output above).');
  }
  console.log('  ok: the demo change was analyzed (1 change, as expected)');
} else console.log('  skipped: the demo branch is missing');
rmSync(out, { recursive: true, force: true });

const cmd = `node "${join(root, 'bin', 'modulegraph.mjs')}"`;
console.log(`
modulegraph is ready.

  Review a change yourself:  cd <your service folder>   then   ${cmd} review
                             (opens the interactive review in your browser; Ctrl+C stops it)
  Ask your agent:            "review my branch at module level"
                             Claude Code has the skill in every project; for another agent, point it at
                             ${join(home, 'module-review.md')}
  Try the demo:              cd "${root}"   then   npm run live   and open http://127.0.0.1:5174
  Update later:              cd "${root}"   then   git pull   and   npm run setup

  Your profiles go in ${join(home, 'configs')}, reviews are written to ${join(home, 'reviews')}.
  Everything runs on this machine; no code or review leaves it.`);
