import { Injectable } from '@nestjs/common';
import { UserRecord } from '../entity/user-record.entity';
import { UserRecordDto } from '../dto/user-record.dto';

/**
 * Normalizes user record data before it is stored or compared: trimmed strings, upper-case country codes,
 * ISO dates, and no empty values.
 */
@Injectable()
export class UserRecordDataTransformer {
  normalize(data: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data ?? {})) {
      if (value === null || value === undefined || value === '') continue;
      if (typeof value === 'string') {
        const trimmed = value.trim();
        out[key] = /country/i.test(key) ? trimmed.toUpperCase() : /date|birth/i.test(key) ? this.toIsoDate(trimmed) : trimmed;
      } else if (typeof value === 'object' && !Array.isArray(value)) {
        out[key] = this.normalize(value as Record<string, unknown>);
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  toDto(record: UserRecord): UserRecordDto {
    return {
      guid: record.guid,
      userGuid: record.userGuid,
      recordType: record.recordType,
      data: record.data,
      statusCode: record.statusCode,
      hasManualData: !!record.manualData,
    };
  }

  private toIsoDate(value: string): string {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().slice(0, 10);
  }
}
