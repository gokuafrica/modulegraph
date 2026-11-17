import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { InternalAuthGuard } from '../../common/guards/internal-auth.guard';
import { AgentGuid } from '../../common/decorators/agent-guid.decorator';
import { CreateCommentDto } from '../dto/create-comment.dto';
import { CommentsService } from '../services/comments.service';

@ApiTags('comments')
@ApiSecurity('internal')
@UseGuards(InternalAuthGuard)
@Controller('v1/internal/user-records/:guid/comments')
export class CommentsController {
  constructor(private readonly commentsService: CommentsService) {}

  @Get()
  @ApiOperation({ summary: 'List comments', description: 'Comments agents left on a record, oldest first.' })
  listComments(@Param('guid') guid: string) {
    return this.commentsService.listComments(guid);
  }

  @Post()
  @ApiOperation({ summary: 'Add a comment', description: 'Adds an agent comment to a record and writes it to the audit trail.' })
  addComment(@Param('guid') guid: string, @Body() dto: CreateCommentDto, @AgentGuid() agentGuid: string) {
    return this.commentsService.addComment(guid, agentGuid, dto.body);
  }
}
