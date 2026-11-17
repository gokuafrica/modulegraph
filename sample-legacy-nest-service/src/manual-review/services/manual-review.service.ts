import { Injectable } from '@nestjs/common';
import { UserRecordService } from '../../user-records/services/user-record.service';
import { UserRecordDataTransformer } from '../../user-records/services/user-record-data.transformer';
import { ApproveDecisionDto } from '../dto/approve-decision.dto';
import { RejectDecisionDto, UpdateUserRecordDataDto } from '../dto/update-user-record-data.dto';
import { ManualReviewResultDto } from '../dto/manual-review-result.dto';
import { ConcludeManualReviewDecisionService } from './conclude-manual-review-decision-service';

@Injectable()
export class ManualReviewService {
  constructor(
    private readonly concludeManualReviewDecisionService: ConcludeManualReviewDecisionService,
    private readonly userRecordService: UserRecordService,
    private readonly userRecordDataTransformer: UserRecordDataTransformer,
  ) {}

  async approveUserRecord(agentGuid: string, guid: string, decision: ApproveDecisionDto): Promise<ManualReviewResultDto> {
    return this.concludeManualReviewDecisionService.approve(agentGuid, guid, decision);
  }

  async updateUserRecordData(agentGuid: string, guid: string, dto: UpdateUserRecordDataDto): Promise<ManualReviewResultDto> {
    return this.concludeManualReviewDecisionService.correctData(agentGuid, guid, dto);
  }

  async rejectUserRecord(agentGuid: string, guid: string, dto: RejectDecisionDto): Promise<ManualReviewResultDto> {
    return this.concludeManualReviewDecisionService.reject(agentGuid, guid, dto);
  }

  async getQueue(page: number, limit: number) {
    const [items, total] = await this.userRecordService.findPendingReview(limit, (page - 1) * limit);
    return { items: items.map((r) => this.userRecordDataTransformer.toDto(r)), total, page };
  }
}
