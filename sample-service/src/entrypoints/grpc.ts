import type { Modules } from '../app.ts';
import { GrpcServer } from '../platform/grpc.ts';

export function registerGrpc(grpc: GrpcServer, m: Modules): void {
  grpc.unary('identity.v1.ProfileService/GetProfile', (req) => m.profile.getProfile(req.userId));
  grpc.unary('identity.v1.ProfileService/GetBirthInfo', (req) => m.profile.getBirthInfo(req.userId));
  grpc.unary('kyc.v1.KycService/RunCheck', (req) => m.kyc.runCheck(req.userId));
  grpc.unary('travel.v1.TravelService/CheckVisa', (req) => m.travel.checkVisa(req.userId, req.destination));
}
