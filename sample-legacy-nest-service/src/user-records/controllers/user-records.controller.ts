import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { InternalAuthGuard } from '../../common/guards/internal-auth.guard';
import { CreateUserRecordDto, UserRecordDto } from '../dto/user-record.dto';
import { UserRecordService } from '../services/user-record.service';
import { UserRecordStatusService } from '../services/user-record-status.service';
import { UserRecordDataTransformer } from '../services/user-record-data.transformer';

@ApiTags('user-records')
@ApiSecurity('internal')
@UseGuards(InternalAuthGuard)
@Controller('v1/internal/user-records')
export class UserRecordsController {
  constructor(
    private readonly userRecordService: UserRecordService,
    private readonly userRecordStatusService: UserRecordStatusService,
    private readonly userRecordDataTransformer: UserRecordDataTransformer,
  ) {}

  @Get(':guid')
  @ApiOperation({ summary: 'Get a user record', description: 'Returns one user record as the user submitted it, with its review status.' })
  @ApiResponse({ status: 200, type: UserRecordDto })
  @ApiResponse({ status: 404, description: 'No user record with this guid' })
  async getUserRecord(@Param('guid') guid: string): Promise<UserRecordDto> {
    const record = await this.userRecordService.getByGuidOrFail(guid);
    return this.userRecordDataTransformer.toDto(record);
  }

  @Get(':guid/status-history')
  @ApiOperation({ summary: 'Status history', description: 'Every review status the record went through, newest first.' })
  getStatusHistory(@Param('guid') guid: string) {
    return this.userRecordStatusService.getHistory(guid);
  }

  @Post()
  @ApiOperation({ summary: 'Create a user record', description: 'Stores a record submitted by a user and puts it in the manual review queue.' })
  @ApiResponse({ status: 201, type: UserRecordDto })
  async createUserRecord(@Body() dto: CreateUserRecordDto): Promise<UserRecordDto> {
    return this.userRecordDataTransformer.toDto(await this.userRecordService.create(dto));
  }
}
