import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class TagDto {
  @ApiProperty({ description: 'Lower-case tag, e.g. "vip" or "fraud-suspected"' })
  @IsString()
  @Matches(/^[a-z0-9-]{2,64}$/)
  tag: string;
}
