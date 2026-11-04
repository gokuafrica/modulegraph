import { Node } from 'ts-morph';
import type { Framework } from './types.ts';

const TYPEORM_READ = ['find', 'findBy', 'findOne', 'findOneBy', 'findOneOrFail', 'findOneByOrFail', 'findAndCount', 'findAndCountBy', 'count', 'countBy', 'exists', 'existsBy', 'sum', 'average', 'minimum', 'maximum'];
const TYPEORM_WRITE = ['save', 'insert', 'update', 'upsert', 'delete', 'remove', 'softDelete', 'softRemove', 'restore', 'recover', 'increment', 'decrement', 'clear'];

/** TypeORM repositories and the entity manager. The table is the entity's (`@Entity('orders')`). */
export const typeorm: Framework = {
  id: 'typeorm',
  name: 'TypeORM',
  packages: ['typeorm'],
  sinks: [
    { class: 'Repository|TreeRepository|MongoRepository|EntityManager', method: TYPEORM_READ, kind: 'db.read', target: 'entity' },
    { class: 'Repository|TreeRepository|MongoRepository|EntityManager', method: TYPEORM_WRITE, kind: 'db.write', target: 'entity' },
  ],
  notModuleDecorators: ['Entity', 'ViewEntity', 'EventSubscriber'],
};

const MONGOOSE_READ = ['find', 'findOne', 'findById', 'countDocuments', 'estimatedDocumentCount', 'exists', 'aggregate', 'distinct'];
const MONGOOSE_WRITE = ['create', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'findOneAndDelete', 'findByIdAndDelete', 'findOneAndReplace', 'bulkWrite'];

/** Mongoose models (plain or `@InjectModel` in Nest). The target is the model's collection. */
export const mongoose: Framework = {
  id: 'mongoose',
  name: 'Mongoose',
  packages: ['mongoose', '@nestjs/mongoose'],
  sinks: [
    { class: 'Model', module: 'mongoose', method: MONGOOSE_READ, kind: 'db.read', target: 'model' },
    { class: 'Model', module: 'mongoose', method: MONGOOSE_WRITE, kind: 'db.write', target: 'model' },
  ],
  notModuleDecorators: ['Schema'],
};

const PRISMA_READ = new Set(['findMany', 'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy']);
const PRISMA_WRITE = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany']);

/**
 * Prisma: `prisma.<model>.<operation>()`. The generated client's delegate types differ per version and
 * generator, so this matches the shape: a known operation on a property whose type is a `…Delegate`.
 */
export const prisma: Framework = {
  id: 'prisma',
  name: 'Prisma',
  packages: ['@prisma/client', 'prisma'],
  hooks: {
    sink(site) {
      const read = PRISMA_READ.has(site.name);
      if (!read && !PRISMA_WRITE.has(site.name)) {
        if (/^\$(queryRaw|queryRawUnsafe)$/.test(site.name)) return { kind: 'db.read', target: 'raw sql' };
        if (/^\$(executeRaw|executeRawUnsafe)$/.test(site.name)) return { kind: 'db.write', target: 'raw sql' };
        return undefined;
      }
      const receiver = site.receiver;
      if (!receiver || !Node.isPropertyAccessExpression(receiver)) return undefined;
      const type = receiver.getType();
      const typeName = type.getAliasSymbol()?.getName() ?? type.getSymbol()?.getName() ?? '';
      if (!/Delegate$/.test(typeName)) return undefined;
      return { kind: read ? 'db.read' : 'db.write', target: receiver.getName() };
    },
  },
};
