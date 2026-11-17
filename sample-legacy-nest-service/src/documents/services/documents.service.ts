import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentDto } from '../dto/document.dto';

@Injectable()
export class DocumentsService {
  constructor(private readonly configService: ConfigService) {}

  async listForRecord(recordGuid: string): Promise<DocumentDto[]> {
    const base = this.configService.get<string>('documentsServiceUrl');
    const response = await fetch(`${base}/v2/records/${recordGuid}/documents`);
    if (!response.ok) {
      return [];
    }
    return (await response.json()) as DocumentDto[];
  }
}
