import { HttpClient } from '../../platform/http.ts';
import type { ExtractedFields, IdentityDocument } from './types.ts';

/**
 * Extracts structured fields from document scans via the document-AI service.
 * @module
 * @owner team-identity
 * @effect http document-ai
 */
export class DocumentExtractor {
  constructor(private readonly http: HttpClient) {}

  async extract(documents: IdentityDocument[]): Promise<ExtractedFields> {
    if (documents.length === 0) throw new Error('no identity documents on file');
    return this.http.post<ExtractedFields>('document-ai', '/v2/extract', { fileRefs: documents.map((d) => d.fileRef) });
  }
}
