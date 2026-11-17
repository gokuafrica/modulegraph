import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { InternalAuthGuard } from '../../common/guards/internal-auth.guard';
import { AgentGuid } from '../../common/decorators/agent-guid.decorator';
import { AssignDto } from '../dto/assign.dto';
import { AssignmentsService } from '../services/assignments.service';

@ApiTags('assignments')
@ApiSecurity('internal')
@UseGuards(InternalAuthGuard)
@Controller('v1/internal/assignments')
export class AssignmentsController {
  constructor(private readonly assignmentsService: AssignmentsService) {}

  @Post(':recordGuid')
  @ApiOperation({ summary: 'Assign a record', description: 'Assigns a record to an agent and notifies them.' })
  assign(@Param('recordGuid') recordGuid: string, @Body() dto: AssignDto) {
    return this.assignmentsService.assign(recordGuid, dto.agentGuid);
  }

  @Get('mine')
  @ApiOperation({ summary: 'My open assignments', description: "The calling agent's open assignments." })
  mine(@AgentGuid() agentGuid: string) {
    return this.assignmentsService.findOpenForAgent(agentGuid);
  }
}
