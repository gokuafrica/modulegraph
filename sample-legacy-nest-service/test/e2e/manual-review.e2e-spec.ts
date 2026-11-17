import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ManualReviewController } from '../../src/manual-review/controllers/manual-review.controller';
import { ManualReviewService } from '../../src/manual-review/services/manual-review.service';

const approveDecision = JSON.parse(readFileSync(join(__dirname, '../fixtures/approve-decision.json'), 'utf8'));

describe('Manual review (e2e)', () => {
  let app: INestApplication;
  const manualReviewService = { approve: jest.fn(async (agentGuid: string, guid: string) => ({ guid, status: 'APPROVED', reviewedBy: agentGuid, recordsUpdated: 2 })) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ManualReviewController],
      providers: [{ provide: ManualReviewService, useValue: manualReviewService }, { provide: ConfigService, useValue: { get: () => 'e2e-key' } }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
  });

  afterAll(() => app.close());

  it('PUT /api/v1/internal/manual-review/approve/:guid', async () => {
    const response = await request(app.getHttpServer())
      .put('/api/v1/internal/manual-review/approve/6f1c2b8e-1d2a-4c55-9a7e-3b0d1f2c9a10')
      .set('x-internal-api-key', 'e2e-key')
      .set('x-agent-guid', 'a7d3c1e0-5b2f-4e8a-9c61-2f4b8d0e7a13')
      .send(approveDecision)
      .expect(200);
    expect(response.body.status).toBe('APPROVED');
  });

  it('rejects a call without the internal API key', async () => {
    await request(app.getHttpServer()).put('/api/v1/internal/manual-review/approve/6f1c2b8e-1d2a-4c55-9a7e-3b0d1f2c9a10').send(approveDecision).expect(401);
  });
});
