# Field report, round 4: never confidently wrong

On the real PR, the changed `approve()` was drawn with one transaction box holding only `setStatus()`, and its three
real writes outside it. Three mechanisms caused it: steps placed where the code is written rather than where it runs,
transaction membership read from position, and calls that couldn't be followed dropped without a word. Round 4 fixes
the mechanisms. The kit is in the repo unchanged ([acceptance/round-4](../../acceptance/README.md)), run with
`npm run accept:r4`; round 2's kit is retired (round 3 has all its checks).

## Your acceptance check (`acceptance/round-4`)

- **Red first.** On `4b292fb` (`npm run accept:r4`, before any change), this Windows machine printed your baseline
  line for line: 30/47. [red-4b292fb-windows.txt](round-4/red-4b292fb-windows.txt).
- **Green, except one.** 46/47 with `--ui`: [green.txt](round-4/green.txt). The one red check is `reassign()`'s
  drawing, a decision the user made (below). Nothing in the fixture is a gap now: `GeoIpClient`'s `catchError`
  callback runs in place, on error, by the NestJS adapter's rxjs rule.
- `npm test` and `npm run accept:r3` (without `--fresh-clone`) pass: [checks.txt](round-4/checks.txt).

## Per contract point

- **A. One disposition per call.** `analyzeFn` gives every call in an operation (helpers included) `step`, `inlined`,
  `external`, `followed` (to `file:line`) or `gap` (with a reason from the closed list), kept per scope. Gaps are on
  `operations[].gaps` (and `entryPoints[].gaps`). `analyze --explain` writes `<id>.explain.json`;
  `modulegraph explain <id> [<Class.method>]` prints it (no operation: the ones with gaps). `done` deletes it.
- **B. Execution order.** Code inside a function literal is no longer walked where it is written. Values are
  followed (functions, transaction handles, objects, lists, destructuring, closures, return values): a literal runs
  where something runs it. Array methods and a promise's continuations run it in place; a project function runs it
  where it calls it, directly (`retry(fn)`) or after storing it (`startTransaction(ds, [cb])` … `executeQueries(ctx)`);
  another operation that calls its parameter runs it right after the call step; anything else is a `function-value`
  gap and its steps are not shown. Library rules come from adapters and from the new profile key `callbacks`
  (`{ "module", "function", "runs": "in-place", "condition"? }`); the NestJS adapter declares the rxjs operators
  (`tap`, `map`, `switchMap`, …; `catchError` on error). An interface call goes to every implementation the wiring
  provides (`useClass`, and a `useFactory` returning its injected instances as a list, with `inject`), with a
  `condition` per implementation when there are several; unbound, it is an `interface-dispatch` gap.
- **C. Transactions from the handle.** A step is in a transaction when it goes through the handle (the query runner,
  what is got from it, the manager a `transaction(cb)` callback is given), as receiver or argument, at any depth of
  helpers. Begin and commit are read from the library's API (TypeORM's, declared in the adapter; matched on the
  library's declarations, never on a project helper). A write in the window without the handle is outside, and the
  flow notes "runs during …, not through it: a rollback doesn't undo it". Handles open at the same time are named
  together, never as one: `2 transactions (legacy, admin), separate commits`, and the box says exactly that (not
  "one transaction").
- **D. Gaps visible.** One ⚠ line on the operation's box with the line and reason (all of them in its tooltip); the
  brief's "Not followed" line under each change. The "≥3 calls and ≥20%" threshold is gone: an untyped call is an
  `untyped` gap of the operation it is in.
- **E. Invariants on every review.** `analyzer/src/invariants.ts` checks I1-I4, I7, I9 on every review (full, lazy,
  every refresh); I5 is checked by the backend (every HTTP route decorator is an entry point). A failure is an
  `incomplete` item of kind `invariant` with a `scope` (its operation or entry point): ⚠ on the box and a line under
  the change in the brief, not the review-wide "incomplete" state.
- **F. The agent's blind check.** Added to the module-review skill as written (step 1b; the brief's template now
  starts with "Check these lines yourself"). New profile key `disagreements`; shown at the top of the brief, on
  `operations[].disagreements` and as the ⚠ on the box. Steps are never changed by it.

## Smaller items

- **R4-3.** A package that can do network I/O but is only used for its plain functions (a URL signer) is not
  flagged; a plain function of a flagged package is not suggested as a sink; calls on its client objects are. A
  flagged package with no call that looks like I/O is suggested for `coverage.ignore`, so every flag comes with a
  rule (I7). The "incomplete" panel shows each item next to its rule with one click.
- **R4-4.** URLs from a config object's property (`config.baseUrl` with `config = configService.getOrThrow('X')`)
  and from destructuring (`const { baseUrl } = configService.get('X')`): `{X.baseUrl}/…`.
- **R4-5.** An unchanged operation without a description shows one quiet line in the inspector; changed ones keep
  the prompt. The skill now asks for every operation the brief lists (Required and "Also met in the flows"), and
  `analyze`/`review` print one line saying descriptions come from the code or the reviewing agent.
- **R4-6.** A read that locks its rows carries `lock` (`for update`, `for share`): TypeORM `lock: { mode }`,
  `setLock(…)`, SQL `FOR UPDATE`. "Behaviour inside" says `NEW db.read \`user_records\`, rows locked for update`.

## Other changes

- `names-check` has the round-4 fixture's helper, parameter and property names (39 names). One exception, listed
  with the name: TypeORM's own `QueryRunner.startTransaction()` in the TypeORM adapter (`frameworks/data.ts`), which
  the transaction API has to name; it is matched on calls the library declares, never on a project's helper.
- `fixtures/frameworks/nest`: the ledger's two query runners were expected as `books + archive transaction` (round 3);
  that was the confidently wrong claim this round is about, so the expectation is now
  `2 transactions (books, archive), separate commits` (the one regression case for R4-2).
- The NestJS adapter declares rxjs operators as running in the request's flow (an interceptor's
  `next.handle().pipe(tap(() => …))`, observer objects `tap({ next, error })` included): without that, every
  interceptor's after-the-handler steps would have become gaps.

## The one check left failing, and why

`[R4-2] reassign(): the strategy steps' writes are in the transaction (both implementations followed), OR it carries
an interface-dispatch gap.` modulegraph follows both implementations (the `useFactory` list with `inject`), each in
the transaction, but draws them as what they are in this service: two modules (`MoveCommentsStep.apply`,
`ReassignRecordStep.apply`), each a call box in `reassign()`'s flow with its write on it, which you drill into. That
is the rule every other call to another module's operation follows (an abstract class bound with `useClass`, which
the check accepts through `effectsOf`, is drawn the same way). The check looks for the writes as steps of
`reassign()` itself. Inlining another module's internals into its caller's flow is what the user asked us not to
do, so we kept the call boxes, and this check stays red. Not a gap: nothing is unfollowed. `reassign()`'s effects
(`operations[].effects`) do include both writes. If you want it checked that way: `effectsOf(C.g,
'ReassignmentService.reassign')` has `db.write review_comments` and `db.write user_records`, and both call steps carry
the transaction.
