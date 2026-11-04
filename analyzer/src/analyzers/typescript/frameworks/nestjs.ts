import type { DecoratorEntryRule } from '../../../config.ts';
import type { Framework } from './types.ts';

const HTTP_VERBS = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'All'];
const READ_VERBS = new Set(['Get', 'Head', 'Options']);

/**
 * NestJS: controllers and their route decorators, microservice message/event handlers (Kafka and other
 * transports), gRPC methods, @nestjs/schedule jobs, BullMQ/Bull processors and @nestjs/event-emitter listeners.
 * Providers (`@Injectable`) are modules; controllers, processors and `@Module` classes host entry points or wire
 * things up, so they are not.
 */
export const nestjs: Framework = {
  id: 'nestjs',
  name: 'NestJS',
  packages: ['@nestjs/core', '@nestjs/common'],
  decoratorEntries: [
    ...HTTP_VERBS.map((verb): DecoratorEntryRule => ({
      decorator: verb,
      from: '@nestjs/common',
      classDecorator: 'Controller',
      kind: 'api',
      label: '{verb} {path}',
      readOnly: READ_VERBS.has(verb),
    })),
    { decorator: 'MessagePattern|EventPattern', from: '@nestjs/microservices', kind: 'consumer', label: 'topic {0}' },
    { decorator: 'GrpcMethod|GrpcStreamMethod', from: '@nestjs/microservices', kind: 'grpc', label: 'gRPC {0|class}/{1|Method}' },
    { decorator: 'Cron', from: '@nestjs/schedule', kind: 'cron', label: 'cron {1.name|method} ({0})' },
    { decorator: 'Interval', from: '@nestjs/schedule', kind: 'cron', label: 'cron {method} (every {1|0} ms)' },
    { decorator: 'Timeout', from: '@nestjs/schedule', kind: 'cron', label: 'cron {method} (once after {1|0} ms)' },
    { decorator: 'OnEvent', from: '@nestjs/event-emitter', kind: 'event', label: 'event {0}' },
    // @nestjs/bullmq: a @Processor('queue') class handles jobs in process(); @nestjs/bull: @Process('job') methods.
    { classDecorator: 'Processor', method: 'process', from: '@nestjs/bullmq', kind: 'queue', label: 'queue {class.0.name|class.0}' },
    { classDecorator: 'Processor', decorator: 'Process', from: '@nestjs/bull', kind: 'queue', label: 'queue {class.0.name|class.0} ({0.name|0|method})' },
  ],
  sinks: [
    { class: 'ClientProxy|ClientKafka|ClientKafkaProxy|ClientRMQ|ClientNats|ClientRedis|ClientMqtt|ClientTCP', method: ['emit', 'send'], kind: 'kafka', target: 'arg:0' },
    { class: 'HttpService', module: '@nestjs/axios', method: ['get', 'post', 'put', 'patch', 'delete', 'head'], kind: 'http', target: 'url:0' },
    { class: 'HttpService', module: '@nestjs/axios', method: 'request', kind: 'http', target: 'url:0.url' },
    { class: 'EventEmitter2', method: ['emit', 'emitAsync'], kind: 'event', target: 'arg:0' },
  ],
  moduleDecorators: ['Injectable'],
  notModuleDecorators: ['Module', 'Controller', 'Catch', 'Resolver', 'WebSocketGateway', 'Processor', 'Global'],
  notModuleImplements: ['CanActivate', 'PipeTransform', 'NestInterceptor', 'ExceptionFilter', 'NestMiddleware'],
  ignoreMethods: ['onModuleInit', 'onModuleDestroy', 'onApplicationBootstrap', 'beforeApplicationShutdown', 'onApplicationShutdown'],
  hooks: {
    /** `app.setGlobalPrefix('api')` in main.ts prefixes every route. */
    globalVars(ctx) {
      const call = ctx.callsNamed('setGlobalPrefix')[0];
      const value = call ? ctx.literal(call.getArguments()[0]) : '';
      return { globalPrefix: value.startsWith('<') || value === '?' ? '' : value };
    },
  },
};
