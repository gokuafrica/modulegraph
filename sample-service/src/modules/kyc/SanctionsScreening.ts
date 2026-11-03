import { HttpClient } from '../../platform/http.ts';

export interface ScreeningResult {
  hit: boolean;
  listVersion: string;
}

/**
 * Screens a person against sanctions and PEP lists.
 */
export class SanctionsScreening {
  constructor(private readonly http: HttpClient) {}

  async screen(person: { name: string; countryOfBirth: string; nationality: string }): Promise<ScreeningResult> {
    return this.http.post<ScreeningResult>('sanctions-api', '/v1/screen', person);
  }
}
