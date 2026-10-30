import { DocumentExtractor } from './DocumentExtractor.ts';
import { DocumentStore } from './DocumentStore.ts';
import type { IdentityData } from './types.ts';

/**
 * Identity: what the user's documents say about them (nationality, country and city of birth, ...).
 * Expensive (DB + document-AI call), so orchestrators fetch it once and pass it down.
 * @module
 * @owner team-identity
 */
export class IdentityModule {
  constructor(
    private readonly documents: DocumentStore,
    private readonly extractor: DocumentExtractor,
  ) {}

  async fetchIdentity(userId: string): Promise<IdentityData> {
    const docs = await this.documents.latestDocuments(userId);
    const fields = await this.extractor.extract(docs);
    return { ...fields, userId, documentIds: docs.map((d) => d.id), extractedAt: new Date().toISOString() };
  }
}
