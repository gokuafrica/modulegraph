import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema()
export class Review {
  @Prop() orderId: string;
  @Prop() text: string;
  @Prop() approved: boolean;
}

export const ReviewSchema = SchemaFactory.createForClass(Review);
