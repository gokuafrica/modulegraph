import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { InternalAuthGuard } from '../../common/guards/internal-auth.guard';
import { AgentGuid } from '../../common/decorators/agent-guid.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ApproveDecisionDto } from '../dto/approve-decision.dto';
import { ManualReviewResultDto } from '../dto/manual-review-result.dto';
import { RejectDecisionDto, UpdateUserRecordDataDto } from '../dto/update-user-record-data.dto';
import { ManualReviewService } from '../services/manual-review.service';

@ApiTags('manual-review')
@ApiSecurity('internal')
@UseGuards(InternalAuthGuard)
@Controller('v1/internal/manual-review')
export class ManualReviewController {
  constructor(private readonly manualReviewService: ManualReviewService) {}

  @Get('queue')
  @ApiOperation({ summary: 'Review queue', description: 'User records waiting for manual review, oldest first.' })
  getQueue(@Query() query: PaginationDto) {
    return this.manualReviewService.getQueue(query.page, query.limit);
  }

  @Put('approve/:guid')
  @ApiOperation({
    summary: 'Approve a user record',
    description: "Approves a user record after manual review: the agent's corrected data is stored (encrypted) on the user's records and every one of them is marked APPROVED.",
  })
  @ApiResponse({ status: 200, type: ManualReviewResultDto, description: 'The record was approved' })
  @ApiResponse({ status: 404, description: 'No user record with this guid' })
  approveUserRecord(@Param('guid') guid: string, @Body() decision: ApproveDecisionDto, @AgentGuid() agentGuid: string): Promise<ManualReviewResultDto> {
    return this.manualReviewService.approve(agentGuid, guid, decision);
  }

  @Put('update/:guid')
  @ApiOperation({
    summary: 'Correct user record data',
    description: "Corrects a user record's data during manual review without changing its status; the corrected data is stored encrypted.",
  })
  @ApiResponse({ status: 200, type: ManualReviewResultDto })
  @ApiResponse({ status: 404, description: 'No user record with this guid' })
  updateUserRecord(@Param('guid') guid: string, @Body() dto: UpdateUserRecordDataDto, @AgentGuid() agentGuid: string): Promise<ManualReviewResultDto> {
    return this.manualReviewService.updateUserRecordData(agentGuid, guid, dto);
  }

  @Put('reject/:guid')
  @ApiOperation({ summary: 'Reject a user record', description: 'Rejects a user record; the reason is shown to the user.' })
  @ApiResponse({ status: 200, type: ManualReviewResultDto })
  rejectUserRecord(@Param('guid') guid: string, @Body() dto: RejectDecisionDto, @AgentGuid() agentGuid: string): Promise<ManualReviewResultDto> {
    return this.manualReviewService.reject(agentGuid, guid, dto);
  }
}
