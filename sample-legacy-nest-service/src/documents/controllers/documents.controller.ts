import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { InternalAuthGuard } from '../../common/guards/internal-auth.guard';
import { DocumentDto } from '../dto/document.dto';
import { DocumentsService } from '../services/documents.service';

@ApiTags('documents')
@ApiSecurity('internal')
@UseGuards(InternalAuthGuard)
@Controller('v1/internal/user-records/:guid/documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get()
  @ApiOperation({ summary: 'Documents of a record', description: 'The documents the user uploaded for this record, from the documents service.' })
  @ApiResponse({ status: 200, type: [DocumentDto] })
  list(@Param('guid') guid: string) {
    return this.documentsService.listForRecord(guid);
  }
}
