import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Column, Entity, PrimaryColumn, Repository } from 'typeorm';
import type { BirthPlace } from '../birth-info/birth-info.types.ts';

/**
 * Birth data extracted from the user's identity document (passport, ID card) by the document pipeline.
 * A column is null when extraction could not read it; there is no row when no document was processed.
 */
@Entity('document_birth_info')
export class DocumentBirthInfo {
  @PrimaryColumn()
  userId: string;

  @Column({ type: 'varchar', nullable: true })
  countryOfBirth: string | null;

  @Column({ type: 'varchar', nullable: true })
  placeOfBirth: string | null;

  @Column()
  documentId: string;
}

/** Read side of the document pipeline: what the user's identity document says about their birth. */
@Injectable()
export class DocumentBirthInfoService {
  constructor(@InjectRepository(DocumentBirthInfo) private readonly extracted: Repository<DocumentBirthInfo>) {}

  /** The document's birth place, with only the parts extraction could read. Null when it read nothing. */
  async forUser(userId: string): Promise<BirthPlace | null> {
    const row = await this.extracted.findOneBy({ userId });
    if (!row || (!row.countryOfBirth && !row.placeOfBirth)) return null;
    return {
      ...(row.countryOfBirth ? { countryOfBirth: row.countryOfBirth } : {}),
      ...(row.placeOfBirth ? { placeOfBirth: row.placeOfBirth } : {}),
    };
  }
}
