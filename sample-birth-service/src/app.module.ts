import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BirthInfoVerifier } from './birth-info/birth-info-verifier.ts';
import { BirthInfoController } from './birth-info/birth-info.controller.ts';
import { BirthInfoService } from './birth-info/birth-info.service.ts';
import { KycBirthInfo, KycBirthInfoStore } from './birth-info/kyc-birth-info.store.ts';
import { DocumentBirthInfo, DocumentBirthInfoService } from './documents/document-birth-info.service.ts';
import { CountryPolicy } from './eligibility/country-policy.service.ts';
import { EligibilityController } from './eligibility/eligibility.controller.ts';
import { EligibilityService } from './eligibility/eligibility.service.ts';
import { AddressCheckClient } from './residency/address-check.client.ts';
import { ResidencyController } from './residency/residency.controller.ts';
import { ResidencyService } from './residency/residency.service.ts';
import { ResidencyDeclaration, ResidencyStore } from './residency/residency.store.ts';

const entities = [DocumentBirthInfo, KycBirthInfo, ResidencyDeclaration];

@Module({
  imports: [
    TypeOrmModule.forRoot({ type: 'postgres', url: process.env.DATABASE_URL, entities }),
    TypeOrmModule.forFeature(entities),
    EventEmitterModule.forRoot(),
  ],
  controllers: [BirthInfoController, EligibilityController, ResidencyController],
  providers: [BirthInfoService, BirthInfoVerifier, KycBirthInfoStore, DocumentBirthInfoService, EligibilityService, CountryPolicy,
    ResidencyService, ResidencyStore, AddressCheckClient],
})
export class AppModule {}
