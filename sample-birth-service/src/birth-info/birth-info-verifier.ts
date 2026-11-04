import { Injectable } from '@nestjs/common';
import type { BirthPlace, KycBirthInfoDto } from './birth-info.types.ts';

type Field = 'countryOfBirth' | 'placeOfBirth';
const FIELDS: Field[] = ['countryOfBirth', 'placeOfBirth'];

export interface BirthInfoMismatch {
  field: Field;
  submitted: string;
  document: string;
}

export interface BirthInfoVerification {
  ok: boolean;
  /** The parts the document has, so the submission had to match them. */
  enforced: Field[];
  mismatches: BirthInfoMismatch[];
}

/** Countries compare as codes, places ignore case and surrounding spaces ("lagos " = "Lagos"). */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Holds what a user submits in KYC to their identity document: every part the document has must match.
 * A part the document is missing (extraction couldn't read it) is not enforced, and with no document data at
 * all the user's answer stands, as it always did.
 */
@Injectable()
export class BirthInfoVerifier {
  verify(submitted: KycBirthInfoDto, document: BirthPlace | null): BirthInfoVerification {
    if (!document) return { ok: true, enforced: [], mismatches: [] };
    const enforced = FIELDS.filter((f) => document[f]);
    const mismatches = enforced
      .filter((f) => normalize(submitted[f]) !== normalize(document[f]!))
      .map((f) => ({ field: f, submitted: submitted[f], document: document[f]! }));
    return { ok: mismatches.length === 0, enforced, mismatches };
  }
}
