import { Db } from '../../platform/db.ts';
import type { IdentityDocument } from './types.ts';

/**
 * Reads the user's uploaded identity documents.
 * @module
 * @owner team-identity
 * @effect db.read user_documents
 */
export class DocumentStore {
  constructor(private readonly db: Db) {}

  async latestDocuments(userId: string): Promise<IdentityDocument[]> {
    const docs = await this.db.select<IdentityDocument & Record<string, unknown>>('user_documents', { userId });
    return docs.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  }
}
