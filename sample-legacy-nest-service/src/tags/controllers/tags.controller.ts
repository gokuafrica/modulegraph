import { Body, Controller, Delete, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { InternalAuthGuard } from '../../common/guards/internal-auth.guard';
import { TagDto } from '../dto/tag.dto';
import { TagsService } from '../services/tags.service';

@ApiTags('tags')
@ApiSecurity('internal')
@UseGuards(InternalAuthGuard)
@Controller('v1/internal/user-records/:guid/tags')
export class TagsController {
  constructor(private readonly tagsService: TagsService) {}

  @Post()
  @ApiOperation({ summary: 'Tag a record', description: 'Adds a tag to a record (idempotent).' })
  addTag(@Param('guid') guid: string, @Body() dto: TagDto) {
    return this.tagsService.addTag(guid, dto.tag);
  }

  @Delete(':tag')
  @ApiOperation({ summary: 'Untag a record', description: 'Removes a tag from a record.' })
  removeTag(@Param('guid') guid: string, @Param('tag') tag: string) {
    return this.tagsService.removeTag(guid, tag);
  }
}
