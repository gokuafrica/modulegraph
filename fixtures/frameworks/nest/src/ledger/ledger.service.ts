import { Body, Controller, Injectable, Post } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Column, DataSource, Entity, PrimaryGeneratedColumn, type QueryRunner } from 'typeorm';
import { AuditService } from '../audit/audit.service.ts';

/**
 * Shapes a real service had (field report, round 3): a URL from a config key held in a field and a local, a
 * transaction opened by hand on two data sources through a helper, entities built in a `map` and saved as an array.
 */

@Entity('ledger_entries')
export class LedgerEntry {
  @PrimaryGeneratedColumn() id: number;
  @Column() account: string;
  @Column() amount: number;
}

@Entity('transfer_log')
export class TransferLog {
  @PrimaryGeneratedColumn() id: number;
  @Column() source: string;
  @Column() destination: string;
}

/** Settings read from the environment (a ConfigService stand-in). */
export const config = {
  getOrThrow(key: string): string {
    const value = process.env[key];
    if (!value) throw new Error(`${key} is not set`);
    return value;
  },
};

@Injectable()
export class RatesClient {
  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = config.getOrThrow('RATES_SERVICE_URL');
  }

  async rate(currency: string): Promise<number> {
    const url = `${this.baseUrl}/rates/${currency}`;
    const res = await fetch(url);
    return ((await res.json()) as { rate: number }).rate;
  }
}

@Injectable()
export class LedgerService {
  constructor(
    @InjectDataSource('books') private readonly booksDb: DataSource,
    @InjectDataSource('archive') private readonly archiveDb: DataSource,
    private readonly rates: RatesClient,
    private readonly audit: AuditService,
  ) {}

  /** Moves an amount between two accounts: the books and the archive commit together. */
  async transfer(source: string, destination: string, amount: number, currency: string): Promise<void> {
    const rate = await this.rates.rate(currency);
    const [books, archive] = await Promise.all([this.begin(this.booksDb), this.begin(this.archiveDb)]);
    try {
      const entries = [source, destination].map((account, i) => books.manager.create(LedgerEntry, { account, amount: (i ? 1 : -1) * amount * rate }));
      await books.manager.save(entries);
      await this.log(archive, source, destination);
      await Promise.all([books.commitTransaction(), archive.commitTransaction()]);
    } catch (e) {
      await Promise.all([books.rollbackTransaction(), archive.rollbackTransaction()]);
      throw e;
    } finally {
      await Promise.all([books.release(), archive.release()]);
    }
    await this.audit.record('transfer', source);
  }

  private async log(runner: QueryRunner, source: string, destination: string): Promise<void> {
    await runner.manager.insert(TransferLog, { source, destination });
  }

  private async begin(dataSource: DataSource): Promise<QueryRunner> {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    return runner;
  }
}

@Controller('ledger')
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Post('transfers')
  transfer(@Body() body: { source: string; destination: string; amount: number; currency: string }): Promise<void> {
    return this.ledger.transfer(body.source, body.destination, body.amount, body.currency);
  }
}
