import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Column, Entity, PrimaryColumn, Repository } from 'typeorm';

@Entity('sessions')
export class Session {
  @PrimaryColumn() token: string;
  @Column() userId: string;
}

@Injectable()
export class SessionsService {
  constructor(@InjectRepository(Session) private readonly sessions: Repository<Session>) {}

  async find(token: string): Promise<Session | null> {
    return this.sessions.findOneBy({ token });
  }
}
