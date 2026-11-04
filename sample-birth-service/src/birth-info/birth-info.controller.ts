import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { BirthInfoService } from './birth-info.service.ts';
import type { BirthInfoView, KycBirthInfoDto } from './birth-info.types.ts';

@Controller('users/:userId/birth-info')
export class BirthInfoController {
  constructor(private readonly birthInfo: BirthInfoService) {}

  @Get()
  get(@Param('userId') userId: string): Promise<BirthInfoView> {
    return this.birthInfo.get(userId);
  }

  /** The user submits (or corrects) their birth info during KYC. */
  @Post()
  update(@Param('userId') userId: string, @Body() dto: KycBirthInfoDto): Promise<BirthInfoView> {
    return this.birthInfo.updateKycBirthInfo(userId, dto);
  }
}
