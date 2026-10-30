type UnaryHandler = (request: any) => Promise<unknown>;

/** Inbound gRPC unary methods, keyed by fully-qualified method name. */
export class GrpcServer {
  readonly methods = new Map<string, UnaryHandler>();

  unary(method: string, handler: UnaryHandler): void {
    this.methods.set(method, handler);
  }
}
