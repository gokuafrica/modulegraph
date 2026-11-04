# Round 4: Haiku on the NestJS branch `feature/order-fraud-hold`

Prompt: "review the branch feature/order-fraud-hold of the service in sample-nest-service at module level.
Follow .claude/skills/module-review/SKILL.md. Reply with only the final brief." No other context.

Ground truth (written before the analyzer was run on this branch):

| Must catch | Caught |
|---|---|
| `Orders.create`: new risk API call; reservation, `orders.created`, `order.created` now only for non-held orders; `orders.held` new | ✓ |
| `status` gains `"held"`: `cancel()` releases stock unconditionally, so cancelling a held order "releases" stock that was never reserved | ✗ saw the new status, not the cancel bug |
| `GET /api/orders/:id` and gRPC `GetOrder` now write `order_views`; not in the commit message | ✓ |
| New `POST /api/orders/:id/release` | ✓ (also: no reviewer role check) |
| Receipts only queued for succeeded payments | ✓ (and called out the brief's "implementation only" line as wrong) |
| Policy constants (0.8, 5000); `create` fails when the risk API is down | ✓ |

Wrong claims: none. Correct extras: `release()` emits `order.created` with the stale `held` object; check-then-act
race in `release()`; 404 where 409 fits; no timeout on the risk call.

Changes made from this round:
- An operation with the same contract but changed guards or steps is now **medium** risk ("1 guard changed inside"),
  and the brief says "behaviour changed inside" instead of "implementation only".
- SKILL.md: for every `gains "<value>"`, check the code paths that act on that field (cancel, expire, refund).

## Haiku's brief (verbatim)

**Goal:** Hold orders with risk at or above 0.8, or total over 5000, for review, and add a release endpoint. The
contract changes match the commit, but the receipt change is also a behaviour change.

**Verdict:** Not blocked by checks. No errors, 9 warnings.

**Contract changes, riskiest first:**
- Orders.get (reach 2) and Orders.cancel (reach 1): +db.write order_views. NEW insert on GET /api/orders/:id and gRPC
  GetOrder, after the not-found check. Cancel gets it through get().
- Fraud.score (reach 1): NEW http call to risk.example.com, sending customerId, country and total.
- Orders.create (reach 1): status gains "held". NEW Fraud.score call. GUARD CHANGED: Inventory.reserve,
  orders.created and order.created now only when not held. NEW orders.held when held.
- Orders.release (reach 1): NEW. Reserves stock, sets status pending, emits orders.created and order.created.
  Writes orders, order_views and stock_items.
- Payments.handleWebhook (reach 1): GUARD CHANGED, receipts only when status is succeeded. The brief's
  "implementation only" line is wrong here.

**New entry points:** POST /api/orders/:id/release (orders.controller.ts:32), behind AuthGuard.

**Findings:** read-path-writes ×1 (order_views on GET). new-side-effect ×9 (all in the contract list).
undisclosed-effect ×1 (order_views is not in the PR description). unattributed-change ×1 (app.module.ts,
order.entity.ts; wiring only).

Code checks beyond the facts:
- release() emits order.created with the pre-update object, so listeners see status "held" while the DB says "pending".
- release() checks the status, then reserves and updates with no lock or conditional update. Concurrent releases can
  reserve stock twice.
- release() throws NotFoundException for "not held"; a 409 fits better.
- Fraud.score has no timeout or fallback. A risk API outage makes POST /api/orders fail.

**Decisions for the human (1-3):**
1. If the risk API fails, should orders be held (fail closed) or placed normally (fail open)?
2. Should the view log stay on GET /api/orders/:id, or move to a command path?
3. Should release require a reviewer role? Today any authenticated caller can release.

**Request review from:** team-checkout, team-payments
**Start here:** http://localhost:5173/#g=branch-feature-order-fraud-hold&v=impact&op=OrdersService.get&d=1
