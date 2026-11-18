/**
 * No sample's names in modulegraph's own code. The analyzer and the UI must work from shapes (a handler map, a base
 * class that registers its instances, a config key chain), never from the words one service happens to use: a rule
 * that only matches the sample passes every check here and fails on the next real service.
 *
 * Scans analyzer/src and ui/src, comments included, except the checks (`*-check.ts`), which test the samples by name.
 * The names: those of the round-2, round-3 and round-4 acceptance fixtures (acceptance/) and of
 * sample-legacy-nest-service: classes, config keys, and the helpers, parameters and properties a fix could be tempted
 * to match (a helper that opens a transaction, the list of callbacks it keeps, the list of strategy steps).
 * One exception, listed with the name: a library's own API that happens to share a name with a fixture's helper
 * (TypeORM's `QueryRunner.startTransaction()`), allowed only in the adapter that declares that library.
 * usage: npm run names-check --workspace analyzer
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NAMES: [string, RegExp, string?][] = [
  // round-2 acceptance fixture
  ['ConsumerHandlerMap', /ConsumerHandlerMap/],
  ['handleMessages', /handleMessages/],
  ['KAFKA_TOPICS', /KAFKA_TOPICS/],
  ['RecordEventsProducer', /RecordEventsProducer/],
  ['records-review-service', /records-review-service/],
  ['SyncFeature', /SyncFeature/],
  ['.local', /\.local\b/],
  // round-3 acceptance fixture (acceptance/round-3)
  ['VendorIdentityClient', /VendorIdentityClient/],
  ['vendorco', /vendorco/i],
  ['RecordNationalityService', /RecordNationalityService/],
  ['RecordMessagesService', /RecordMessagesService/],
  ['UserRecordStatusService', /UserRecordStatusService/],
  ['ReviewerDirectoryService', /ReviewerDirectoryService/],
  ['LOCKS_SERVICE_BASE_URL', /LOCKS_SERVICE_BASE_URL/],
  ['GEOIP_PROXY_BASE_URL', /GEOIP_PROXY_BASE_URL/],
  ['ASSESSMENTS_SERVICE_BASE_URL', /ASSESSMENTS_SERVICE_BASE_URL/],
  ['VENDOR_WORKFLOW_API_BASE_URL', /VENDOR_WORKFLOW_API_BASE_URL/],
  ['captcha-vendor', /captcha-vendor/],
  // round-4 acceptance fixture (acceptance/round-4): helpers, parameters and properties
  ['startTransaction', /startTransaction/, 'analyzer/src/analyzers/typescript/frameworks/data.ts'],
  ['executeQueries', /executeQueries/],
  ['TransactionContext', /TransactionContext/i],
  ['queries (as a name to match)', /['"`]queries['"`]|\.queries\b/],
  ['steps (as a name to match)', /['"`]steps['"`]/],
  ['REASSIGNMENT_STEPS', /REASSIGNMENT_STEPS/],
  ['ReassignmentStep', /Reassign(ment|Record)Step|MoveCommentsStep/],
  ['setUserRecordManualReviewData', /setUserRecordManualReviewData/],
  ['signUrl', /signUrl|url-signer/],
  ['ASSESSMENT_SERVICE_CONFIG', /ASSESSMENT_SERVICE_CONFIG/],
  ['IDENTITY_MANAGER_CONFIG', /IDENTITY_MANAGER_CONFIG/],
  ['NationalityAuditService', /NationalityAudit/],
  ['DocumentArchiveService', /DocumentArchive|HttpFileStorage/],
  ['GeoIpClient', /GeoIpClient/],
  // bug note 1 (acceptance/round-4): the status handlers' Map and the hook list filled at run time
  ['UserRecordStatusService', /UserRecordStatus/],
  ['statusHandlers / statusHooks', /status(Handlers|Hooks)/],
  ['onStatusChanged', /onStatusChanged/],
  ['set…Status handlers', /set(Approved|Rejected|RecheckRejected)Status/],
  ['UNREADABLE', /UNREADABLE|RECHECK_REJECTED/],
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
    for (const [name, re, allowedIn] of NAMES) {
      if (!re.test(line) || (allowedIn && relative(repo, file).replace(/\\/g, '/') === allowedIn)) continue;
      console.log(`  ✖ ${relative(repo, file).replace(/\\/g, '/')}:${i + 1} names \`${name}\`: ${line.trim().slice(0, 120)}`);
      hits++;
    }
  });
}
console.log(hits ? `\n${hits} sample name(s) in modulegraph's own code: describe the shape instead` : `names: no sample names in analyzer/src or ui/src (checks excluded), ${NAMES.length} names`);
process.exit(hits ? 1 : 0);
