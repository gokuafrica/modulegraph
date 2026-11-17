/**
 * No sample's names in modulegraph's own code. The analyzer and the UI must work from shapes (a handler map, a base
 * class that registers its instances, a config key chain), never from the words one service happens to use: a rule
 * that only matches the sample passes every check here and fails on the next real service.
 *
 * Scans analyzer/src and ui/src, comments included, except the checks (`*-check.ts`), which test the samples by name.
 * The names: those of the round-2 acceptance fixture (acceptance/round-2) and of sample-legacy-nest-service.
 * usage: npm run names-check --workspace analyzer
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NAMES: [string, RegExp][] = [
  // round-2 acceptance fixture
  ['ConsumerHandlerMap', /ConsumerHandlerMap/],
  ['handleMessages', /handleMessages/],
  ['KAFKA_TOPICS', /KAFKA_TOPICS/],
  ['RecordEventsProducer', /RecordEventsProducer/],
  ['records-review-service', /records-review-service/],
  ['SyncFeature', /SyncFeature/],
  ['.local', /\.local\b/],
  // sample-legacy-nest-service and its packages
  ['ConcludeManualReview', /ConcludeManualReview/],
  ['user-records-service', /user-records-service/],
  ['AuditEventsPublisher', /AuditEventsPublisher/],
  ['ConsumersManager', /ConsumersManager/],
  ['createSyncedMessage', /createSyncedMessage/],
  ['addHandler', /addHandler/],
  ['@acme', /@acme\b/],
];

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' ? [] : files(p);
    return /\.(ts|tsx|mjs|css)$/.test(n) && !/-check\.ts$/.test(n) ? [p] : [];
  });

let hits = 0;
for (const file of [...files(join(repo, 'analyzer/src')), ...files(join(repo, 'ui/src'))]) {
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    for (const [name, re] of NAMES) {
      if (!re.test(line)) continue;
      console.log(`  ✖ ${relative(repo, file).replace(/\\/g, '/')}:${i + 1} names \`${name}\`: ${line.trim().slice(0, 120)}`);
      hits++;
    }
  });
}
console.log(hits ? `\n${hits} sample name(s) in modulegraph's own code: describe the shape instead` : `names: no sample names in analyzer/src or ui/src (checks excluded), ${NAMES.length} names`);
process.exit(hits ? 1 : 0);
