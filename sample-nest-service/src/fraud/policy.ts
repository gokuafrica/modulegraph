import type { Tier } from '../customers/customers.service.ts';

/** Risk score (0..1) from which an order waits for a fraud reviewer. */
export const HOLD_THRESHOLD = 0.8;

/** Orders above this total are always reviewed, unless the customer is gold or platinum. */
export const ALWAYS_REVIEW_ABOVE = 5000;

export function needsReview(score: number, total: number, tier: Tier): boolean {
  if (score >= HOLD_THRESHOLD) return true;
  return total > ALWAYS_REVIEW_ABOVE && tier === 'standard';
}
