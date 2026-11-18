# Bug note 1 (after round 4): loops over callbacks, gaps carried up, every box described

Two bugs from the held-out test (B1, B2), one change the user asked for (B3), and two small items. The updated
round-4 kit is in the repo as sent ([acceptance/round-4](../../acceptance/README.md)): `create-r4-fixture.mjs` and
`accept-r4.mjs` replaced, `red-baseline-b4776f4.txt` in place of the round-4 baseline. Run it with
`npm run accept:r4`.

## The kit (`acceptance/round-4`, 63 checks)

- **Red first.** On `b4776f4`, before any change, this Windows machine printed your baseline: 48/63, failing only B1,
  B2 and B3. [red-b4776f4-windows.txt](bug-note-1/red-b4776f4-windows.txt).
- **Green.** 63/63 with `--ui`: [green.txt](bug-note-1/green.txt).
- `npm test` passes.

## B1. A loop over callbacks runs each once

A loop is a repetition unless it dispatches. Every step now remembers the function values whose running produced it.
A loop over a collection that holds functions (the list of callbacks itself, or objects that each hold their own:
`contexts.map((c) => this.executeQueries(c))`) doesn't mark what those functions produced as "once per item". What
else is in its body, and loops inside the callbacks, still are. Loops over data that call the same function per element
are unchanged. `approve()` and `updateUserRecordData()` have no looped step on either side, and the per-row update is
still looped. So the real fix (one update became one per row) now shows as a change.

## B2. Gaps carried up, and handler collections followed

- **Carried up.** After the transitive effects, every operation and entry point gets the gaps of what it reaches,
  after its own ones, as `{ file, line, reason, via }` (`via`: the operation the gap is in; own gaps have none). They
  are recomputed from the own gaps each time, so lazy and full analyses stay equal. The box's ⚠ says "reaches a gap in
  `UserRecordStatusService.setStatus` line 41". The brief lists it under the change, on one line, and no longer says
  "same inputs, outputs and side effects" when a gap is reachable: it says the side effects are the same "as far as they
  are followed". The header doesn't say "all clear" when a change reaches a gap: it says how many changes have calls not
  followed. I9 holds. The "no gap" checks and the gap budget count own gaps.
- **The Map of handlers.** A field the class fills once (initializer or constructor) with a collection literal
  (`new Map([[k, this.m], …])`, `{ [k]: this.m }`, `[this.m, …]`) whose values are all project methods or arrow
  properties is followed: `.get(k)`, `[k]`, `.values()` and iteration give every value. Each value carries a
  condition naming its keys (`when status is 'REJECTED' or 'UNREADABLE'`) when there are several. Anything else in the
  class that changes the field (`push`, `set`, `this.x[k] = …`, an assignment outside the constructor) and it is not
  followed: the run-time hook list stays a `function-value` gap, carried up to `approve()` and to the facade.

## B3. Every box in the affected flows asks for a description

The brief's list is now every undescribed operation drawn from each affected entry point, at any drill-in depth, with
the request pipeline's steps included. The changed ones come first under "Required" and the rest under "Also in the
flows", required too, with no cap. All of them are in the JSON skeleton. The inspector asks on an unchanged box as on
a changed one (the quiet line is gone). The skill says: "describe every operation the brief lists, changed or not; the
brief is done only when the list is gone". Its check-it-took rule applies to the whole list. A doc comment or API docs
in the code still win, and modulegraph writes none itself.

## Small items

- **Which transaction a step commits with.** In a box of several transactions, each step carries `commitsWith` (its
  handle's name). The flow shows "commits with legacy" on the step, and the brief says "in the legacy transaction (one
  of 2 transactions (legacy, admin), separate commits)". The box keeps the combined label.
- **`getSignedUrl`.** `@aws-sdk/s3-request-presigner` declares it as `export declare const getSignedUrl: (…) => …`, a
  constant of function type, not a `function`. Such a call got no call site at all, so the package looked "imported"
  but never called, and was flagged with a `coverage.ignore` suggestion. A module-level constant whose type is callable
  is now a plain function like any other, so a package used only for plain functions is not flagged. Not verified on
  the real package: it isn't installed here, and the budget rules out new samples.

## Other changes

- `names-check` has the new fixture names (44 names).
- `docs/analyzers.md`: dispatch loops, carried gaps, handler collections, `commitsWith`, and what the description list
  covers.
