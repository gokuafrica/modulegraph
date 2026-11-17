import { Body, Controller, Param, ParseIntPipe, Post, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { InternalAuthGuard } from '../../common/guards/internal-auth.guard';
import { AgentGuid } from '../../common/decorators/agent-guid.decorator';
import { OpenEscalationDto, ResolveEscalationDto } from '../dto/escalation.dto';
import { EscalationsService } from '../services/escalations.service';

@ApiTags('escalations')
@ApiSecurity('internal')
@UseGuards(InternalAuthGuard)
@Controller('v1/internal/escalations')
export class EscalationsController {
  constructor(private readonly escalationsService: EscalationsService) {}

  @Post(':recordGuid')
  @ApiOperation({ summary: 'Escalate a record', description: 'Sends a record to a senior agent and notifies the escalation channel.' })
  open(@Param('recordGuid') recordGuid: string, @Body() dto: OpenEscalationDto, @AgentGuid() agentGuid: string) {
    return this.escalationsService.open(recordGuid, dto.reason, agentGuid);
  }

  @Put(':id/resolve')
  @ApiOperation({ summary: 'Resolve an escalation', description: "A senior agent closes an escalation, approving the record with their decision or dismissing it." })
  resolve(@Param('id', ParseIntPipe) id: number, @Body() dto: ResolveEscalationDto, @AgentGuid() agentGuid: string) {
    return this.escalationsService.resolve(id, agentGuid, dto);
  }
}
