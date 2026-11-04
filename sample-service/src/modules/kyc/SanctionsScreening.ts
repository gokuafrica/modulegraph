import { HttpClient } from '../../platform/http.ts';

export interface ScreeningResult {
  hit: boolean;
  /** 0..1 similarity of the best list match. */
  score: number;
  listVersion: string;
}

/**
 * Screens a person against sanctions and PEP lists.
 */
export class SanctionsScreening {
  constructor(private readonly http: HttpClient) {}

  async screen(person: { name: string; countryOfBirth: string; nationality: string }): Promise<ScreeningResult> {
    const query = { ...person, name: normaliseName(person.name) };
    let response: { hit: boolean; score?: number; listVersion: string };
    try {
      response = await this.http.post('sanctions-api', '/v2/screen', query);
    } catch {
      // The list provider times out under load; one retry is cheaper than failing the whole KYC check.
      response = await this.http.post('sanctions-api', '/v2/screen', query);
    }
    return { hit: response.hit, score: response.score ?? (response.hit ? 1 : 0), listVersion: response.listVersion };
  }
}

function normaliseName(name: string): string {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
}
