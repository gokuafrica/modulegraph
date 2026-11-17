import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { UserRecord } from '../entity/user-record.entity';
import { CreateUserRecordDto } from '../dto/user-record.dto';
import { UserRecordStatusCode } from '../user-record-status.enum';

@Injectable()
export class UserRecordService {
  constructor(@InjectRepository(UserRecord, 'legacy') private readonly userRecordRepository: Repository<UserRecord>) {}

  getByGuid(guid: string): Promise<UserRecord | null> {
    return this.userRecordRepository.findOne({ where: { guid } });
  }

  async getByGuidOrFail(guid: string): Promise<UserRecord> {
    const record = await this.getByGuid(guid);
    if (!record) {
      throw new NotFoundException(`User record ${guid} not found`);
    }
    return record;
  }

  findAllByUserGuid(userGuid: string): Promise<UserRecord[]> {
    return this.userRecordRepository.find({ where: { userGuid }, order: { createdAt: 'ASC' } });
  }

  findPendingReview(limit: number, offset: number): Promise<[UserRecord[], number]> {
    return this.userRecordRepository.findAndCount({ where: { statusCode: UserRecordStatusCode.PENDING_REVIEW }, take: limit, skip: offset, order: { createdAt: 'ASC' } });
  }

  async create(dto: CreateUserRecordDto): Promise<UserRecord> {
    const record = this.userRecordRepository.create({ ...dto, guid: randomUUID(), statusCode: UserRecordStatusCode.PENDING_REVIEW });
    return this.userRecordRepository.save(record);
  }
}
