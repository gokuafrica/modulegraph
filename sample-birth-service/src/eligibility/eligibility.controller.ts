import { Controller, Get, Param } from '@nestjs/common';
import { type Eligibility, EligibilityService } from './eligibility.service.ts';

@Controller('users/:userId/eligibility')
export class EligibilityController {
  constructor(private readonly eligibility: EligibilityService) {}

  @Get()
  check(@Param('userId') userId: string): Promise<Eligibility> {
    return this.eligibility.check(userId);
  }
}
