import type { KycResult } from './KycModule.ts';

export type RiskTier = 'low' | 'medium' | 'high';

/** Countries whose births or passports need enhanced due diligence. */
const ENHANCED_DUE_DILIGENCE = new Set(['IRN', 'PRK', 'SYR', 'MMR', 'IND']);

export interface RiskInput {
  countryOfBirth: string;
  nationality: string;
  screeningScore: number;
}

/** Combines the sanctions score with where the person was born and which passport they hold. */
export function riskTier(input: RiskInput): RiskTier {
  let points = Math.round(input.screeningScore * 10);
  if (ENHANCED_DUE_DILIGENCE.has(input.countryOfBirth)) points += 3;
  if (ENHANCED_DUE_DILIGENCE.has(input.nationality)) points += 2;
  if (input.countryOfBirth !== input.nationality) points += 1;
  if (points >= 6) return 'high';
  return points >= 3 ? 'medium' : 'low';
}

/** High-risk results always go to a human; medium only when the previous check was not a pass. */
export function needsManualReview(tier: RiskTier, previous?: KycResult): boolean {
  if (tier === 'high') return true;
  return tier === 'medium' && previous !== undefined && previous.status !== 'passed';
}
