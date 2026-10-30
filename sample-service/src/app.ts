import { BirthConsentStore } from './modules/birth-info/BirthConsentStore.ts';
import { BirthInfoModule } from './modules/birth-info/BirthInfoModule.ts';
import { DocumentBirthExtractor } from './modules/birth-info/DocumentBirthExtractor.ts';
import { ComplianceReportModule } from './modules/compliance/ComplianceReportModule.ts';
import { IdentityReviewModule } from './modules/admin/IdentityReviewModule.ts';
import { DocumentExtractor } from './modules/identity/DocumentExtractor.ts';
import { DocumentStore } from './modules/identity/DocumentStore.ts';
import { IdentityModule } from './modules/identity/IdentityModule.ts';
import { KycModule } from './modules/kyc/KycModule.ts';
import { SanctionsScreening } from './modules/kyc/SanctionsScreening.ts';
import { NationalityModule } from './modules/nationality/NationalityModule.ts';
import { OnboardingModule } from './modules/onboarding/OnboardingModule.ts';
import { PersonalDetailsModule } from './modules/personal-details/PersonalDetailsModule.ts';
import { ProfileService } from './modules/profile/ProfileService.ts';
import { TaxResidencyModule } from './modules/tax/TaxResidencyModule.ts';
import { TravelEligibilityModule } from './modules/travel/TravelEligibilityModule.ts';
import { registerConsumers } from './entrypoints/consumers.ts';
import { registerCronJobs } from './entrypoints/cron.ts';
import { registerGrpc } from './entrypoints/grpc.ts';
import { registerAdminRoutes } from './entrypoints/http/adminRoutes.ts';
import { registerComplianceRoutes } from './entrypoints/http/complianceRoutes.ts';
import { registerProfileRoutes } from './entrypoints/http/profileRoutes.ts';
import { Db } from './platform/db.ts';
import { GrpcServer } from './platform/grpc.ts';
import { HttpClient, HttpRouter } from './platform/http.ts';
import { KafkaConsumer, KafkaProducer } from './platform/kafka.ts';
import { Outbox } from './platform/outbox.ts';
import { Scheduler } from './platform/scheduler.ts';

/** Composition root: the only place that knows how modules are wired together. */
export function buildApp() {
  const db = new Db();
  const http = new HttpClient();
  const kafka = new KafkaProducer();
  const outbox = new Outbox(db);

  const identity = new IdentityModule(new DocumentStore(db), new DocumentExtractor(http));
  const nationality = new NationalityModule(db);
  const personalDetails = new PersonalDetailsModule(db);
  const birthInfo = new BirthInfoModule(new DocumentBirthExtractor(), new BirthConsentStore(db), outbox);

  const profile = new ProfileService(db, kafka, identity, nationality, personalDetails, birthInfo);
  const kyc = new KycModule(db, outbox, identity, birthInfo, nationality, new SanctionsScreening(http));
  const tax = new TaxResidencyModule(db, identity, birthInfo, nationality);
  const travel = new TravelEligibilityModule(db, http, identity, nationality, personalDetails, birthInfo);
  const onboarding = new OnboardingModule(db, kafka, kyc);
  const compliance = new ComplianceReportModule(db, http, tax);
  const review = new IdentityReviewModule(db, identity, birthInfo);

  const modules = { profile, kyc, tax, travel, onboarding, compliance, review, birthInfo };
  const router = new HttpRouter();
  const grpc = new GrpcServer();
  const consumer = new KafkaConsumer('identity-profile-service');
  const scheduler = new Scheduler();

  registerProfileRoutes(router, modules);
  registerComplianceRoutes(router, modules);
  registerAdminRoutes(router, modules);
  registerGrpc(grpc, modules);
  registerConsumers(consumer, kafka, modules);
  registerCronJobs(scheduler, modules);

  return { db, http, kafka, router, grpc, scheduler, modules };
}

export type Modules = ReturnType<typeof buildApp>['modules'];
