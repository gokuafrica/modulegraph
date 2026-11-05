import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ResidencyService } from './residency.service.ts';
import type { ResidencyDeclarationDto, ResidencyView } from './residency.types.ts';

@Controller('users/:userId/residency')
export class ResidencyController {
  constructor(private readonly residency: ResidencyService) {}

  @Get()
  get(@Param('userId') userId: string): Promise<ResidencyView> {
    return this.residency.get(userId);
  }

  /** The user declares (or changes) their home address during KYC. */
  @Post()
  declare(@Param('userId') userId: string, @Body() dto: ResidencyDeclarationDto): Promise<ResidencyView> {
    return this.residency.declare(userId, dto);
  }
}
