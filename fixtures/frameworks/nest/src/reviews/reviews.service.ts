import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Review } from './review.schema.ts';

@Injectable()
export class ReviewsService {
  constructor(@InjectModel(Review.name) private readonly reviews: Model<Review>) {}

  async list(orderId: string): Promise<Review[]> {
    return this.reviews.find({ orderId });
  }

  async approve(id: string): Promise<void> {
    const review = await this.reviews.findById(id);
    if (!review) throw new NotFoundException();
    review.approved = true;
    await review.save();
  }

  async remove(id: string): Promise<void> {
    const review = await this.reviews.findById(id);
    await review?.deleteOne();
  }
}
