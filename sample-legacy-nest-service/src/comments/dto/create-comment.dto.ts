import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class CreateCommentDto {
  @ApiProperty({ description: 'Comment text shown to other agents', maxLength: 2000 })
  @IsString()
  @MaxLength(2000)
  body: string;
}
