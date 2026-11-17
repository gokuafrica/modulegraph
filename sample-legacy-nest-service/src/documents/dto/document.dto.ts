import { ApiProperty } from '@nestjs/swagger';

export class DocumentDto {
  @ApiProperty({ description: 'Document id in the documents service' })
  id: string;

  @ApiProperty({ description: 'passport, id_card, utility_bill, …' })
  type: string;

  @ApiProperty({ description: 'Short-lived download link' })
  url: string;
}
