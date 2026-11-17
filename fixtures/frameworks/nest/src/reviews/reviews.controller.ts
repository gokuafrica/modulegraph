import { Controller, Delete, Get, Param, Post, Query, UseInterceptors } from '@nestjs/common';
import { AuditInterceptor } from '../common/audit.interceptor.ts';
import { Review } from './review.schema.ts';
import { ReviewsService } from './reviews.service.ts';

@Controller('reviews')
@UseInterceptors(AuditInterceptor)
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  list(@Query('orderId') orderId: string): Promise<Review[]> {
    return this.reviews.list(orderId);
  }

  @Post(':id/approve')
  approve(@Param('id') id: string): Promise<void> {
    return this.reviews.approve(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string): Promise<void> {
    return this.reviews.remove(id);
  }
}
