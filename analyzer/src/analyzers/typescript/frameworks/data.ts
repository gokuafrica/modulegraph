import { Node } from 'ts-morph';
import { collectionName } from '../extract.ts';
import type { Framework, HookContext } from './types.ts';

const TYPEORM_READ = ['find', 'findBy', 'findOne', 'findOneBy', 'findOneOrFail', 'findOneByOrFail', 'findAndCount', 'findAndCountBy', 'count', 'countBy', 'exists', 'existsBy', 'sum', 'average', 'minimum', 'maximum'];
const TYPEORM_WRITE = ['save', 'insert', 'update', 'upsert', 'delete', 'remove', 'softDelete', 'softRemove', 'restore', 'recover', 'increment', 'decrement', 'clear'];

/** Query builder calls that run the query and return rows. */
const QB_READ = new Set(['getMany', 'getOne', 'getOneOrFail', 'getRawMany', 'getRawOne', 'getManyAndCount', 'getRawAndEntities', 'getCount', 'getExists', 'stream']);
/** Builders whose `execute()` writes. */
const QB_WRITERS = new Set(['InsertQueryBuilder', 'UpdateQueryBuilder', 'DeleteQueryBuilder', 'SoftDeleteQueryBuilder']);
/** Classes and interfaces with a raw `query(sql, params)`. */
const RAW_QUERY = new Set(['DataSource', 'Connection', 'EntityManager', 'QueryRunner', 'BaseQueryRunner', 'Repository']);

/**
 * TypeORM repositories and the entity manager. The table is the entity's (`@Entity('orders')`). Query builders
 * count where the query runs (`getMany()` reads, `execute()` on an insert/update/delete builder writes); raw
 * `query(sql)` is classified by its SQL.
 */
export const typeorm: Framework = {
  id: 'typeorm',
  name: 'TypeORM',
  packages: ['typeorm'],
  sinks: [
    { class: 'Repository|TreeRepository|MongoRepository|EntityManager', method: TYPEORM_READ, kind: 'db.read', target: 'entity' },
    { class: 'Repository|TreeRepository|MongoRepository|EntityManager', method: TYPEORM_WRITE, kind: 'db.write', target: 'entity' },
  ],
  notModuleDecorators: ['Entity', 'ViewEntity', 'EventSubscriber'],
  hooks: {
    sink(site, ctx) {
      if (site.pkg !== 'typeorm') return undefined;
      if (site.name === 'query' && RAW_QUERY.has(site.owner)) return rawSql(site.call.getArguments()[0], ctx);
      if (!/QueryBuilder$/.test(site.owner)) return undefined;
      // The builder's own type says what it is, even when `execute` is declared on the base QueryBuilder.
      const builder = site.receiver?.getType().getSymbol()?.getName() ?? site.owner;
      let kind: 'db.read' | 'db.write' | undefined;
      if (QB_READ.has(site.name)) kind = 'db.read';
      else if (site.name === 'execute') kind = QB_WRITERS.has(builder) ? 'db.write' : builder === 'SelectQueryBuilder' ? 'db.read' : 'db.write';
      else if (builder === 'RelationQueryBuilder' && ['add', 'remove', 'set', 'addAndRemove'].includes(site.name)) kind = 'db.write';
      if (!kind) return undefined;
      return { kind, target: builderTable(site.receiver, ctx) ?? 'query builder' };
    },
  },
};

/**
 * The table a query builder works on: its entity type (`UpdateQueryBuilder<Order>`), else what the chain names
 * (`.update(Order)`, `.into('orders')`, `.from(Order, 'o')`, `createQueryBuilder(Order, 'o')`), else its alias.
 * Follows the chain through variables (`const qb = repo.createQueryBuilder('o'); …; qb.getMany()`).
 */
function builderTable(receiver: Node | undefined, ctx: HookContext): string | undefined {
  const fromType = receiver && ctx.table(receiver.getType().getTypeArguments()[0] ?? receiver.getType());
  if (fromType) return fromType;
  let alias: string | undefined;
  for (let cur = receiver, depth = 0; cur && depth < 30; depth++) {
    if (Node.isIdentifier(cur)) {
      const decl = ctx.resolve(cur);
      cur = decl && Node.isVariableDeclaration(decl) ? decl.getInitializer() : undefined;
      continue;
    }
    if (Node.isAwaitExpression(cur) || Node.isParenthesizedExpression(cur)) {
      cur = cur.getExpression();
      continue;
    }
    if (!Node.isCallExpression(cur)) break;
    const callee = cur.getExpression();
    const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : '';
    const [first, second] = cur.getArguments();
    if (['update', 'into', 'from', 'createQueryBuilder', 'insertInto', 'deleteFrom'].includes(name) && first) {
      const named = ctx.table(first) ?? (Node.isStringLiteral(first) ? first.getLiteralValue() : undefined);
      if (named) return named;
      // createQueryBuilder('o') on a repository: the alias, if nothing better turns up.
      if (name === 'createQueryBuilder' && !second) alias ??= ctx.literal(first);
    }
    if (name === 'createQueryBuilder' && second) alias ??= ctx.literal(second);
    cur = Node.isPropertyAccessExpression(callee) ? callee.getExpression() : undefined;
  }
  return alias && !alias.startsWith('<') && alias !== '?' ? alias : undefined;
}

const SQL_READ = new Set(['select', 'show', 'explain', 'values', 'table', 'describe']);

/**
 * Raw SQL (`dataSource.query('UPDATE orders …')`, `$queryRaw`): read or write from the leading keyword, table from
 * the statement. SQL that isn't a literal can't be classified: it counts as a write to "raw sql", so a review
 * never treats unknown SQL as harmless.
 */
export function rawSql(arg: Node | undefined, ctx: HookContext): { kind: 'db.read' | 'db.write'; target: string } {
  let text: string | undefined;
  if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) text = arg.getLiteralValue();
  else if (arg && Node.isTemplateExpression(arg)) text = arg.getHead().getLiteralText() + arg.getTemplateSpans().map((s) => `? ${s.getLiteral().getLiteralText()}`).join('');
  else if (arg) {
    const value = ctx.literal(arg);
    if (!value.startsWith('<') && value !== '?') text = value;
  }
  const sql = (text ?? '').replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
  const keyword = /^\(*\s*([a-z]+)/i.exec(sql)?.[1]?.toLowerCase();
  if (!keyword) return { kind: 'db.write', target: 'raw sql' };
  // WITH … : a CTE writes when its statements do.
  const writes = keyword === 'with' ? /\b(insert\s+into|update\s+[\w".]+\s+set|delete\s+from|merge\s+into)\b/i.test(sql) : !SQL_READ.has(keyword);
  const table = (writes
    ? /\b(?:insert\s+into|update|delete\s+from|merge\s+into|truncate(?:\s+table)?|replace\s+into|upsert\s+into)\s+(?:only\s+)?([\w".`[\]]+)/i.exec(sql)
    : /\bfrom\s+([\w".`[\]]+)/i.exec(sql))?.[1]?.replace(/["`[\]]/g, '');
  return { kind: writes ? 'db.write' : 'db.read', target: table && !/^(select|\(|\?)$/i.test(table) ? table : 'raw sql' };
}

const MONGOOSE_READ = ['find', 'findOne', 'findById', 'countDocuments', 'estimatedDocumentCount', 'exists', 'aggregate', 'distinct'];
const MONGOOSE_WRITE = ['create', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'findOneAndDelete', 'findByIdAndDelete', 'findOneAndReplace', 'bulkWrite'];

const MONGOOSE_DOC_WRITE = new Set(['save', 'deleteOne', 'updateOne', 'replaceOne']);

/**
 * Mongoose models (plain or `@InjectModel` in Nest), and documents loaded or built from them
 * (`doc.save()`, `doc.deleteOne()`). The target is the model's collection.
 */
export const mongoose: Framework = {
  id: 'mongoose',
  name: 'Mongoose',
  packages: ['mongoose', '@nestjs/mongoose'],
  sinks: [
    { class: 'Model', module: 'mongoose', method: MONGOOSE_READ, kind: 'db.read', target: 'model' },
    { class: 'Model', module: 'mongoose', method: MONGOOSE_WRITE, kind: 'db.write', target: 'model' },
  ],
  notModuleDecorators: ['Schema'],
  hooks: {
    sink(site, ctx) {
      if (site.pkg !== 'mongoose' || site.owner !== 'Document' || !MONGOOSE_DOC_WRITE.has(site.name) || !site.receiver) return undefined;
      return { kind: 'db.write', target: documentCollection(site.receiver, ctx) ?? 'document' };
    },
  },
};

/**
 * Collection of a document: the model it came from (`const doc = await this.orders.findById(id)`,
 * `new this.orders({…})`), else the document's own type (`HydratedDocument<Order>`).
 */
function documentCollection(receiver: Node, ctx: HookContext): string | undefined {
  let cur: Node | undefined = receiver;
  for (let depth = 0; cur && depth < 12; depth++) {
    if (Node.isIdentifier(cur)) {
      const decl = ctx.resolve(cur);
      cur = decl && Node.isVariableDeclaration(decl) ? decl.getInitializer() : undefined;
    } else if (Node.isAwaitExpression(cur) || Node.isParenthesizedExpression(cur) || Node.isNonNullExpression(cur) || Node.isAsExpression(cur)) {
      cur = cur.getExpression();
    } else if (Node.isNewExpression(cur)) {
      return ctx.collection(cur.getExpression());
    } else if (Node.isCallExpression(cur)) {
      // this.orders.findById(id).exec() → this.orders
      const callee = cur.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) break;
      const target = callee.getExpression();
      const model = Node.isPropertyAccessExpression(target) || Node.isIdentifier(target) ? target.getType().getSymbol()?.getName() : undefined;
      if (model === 'Model') return ctx.collection(target);
      cur = target;
    } else break;
  }
  const type = receiver.getType().getNonNullableType();
  for (const t of [type, ...type.getIntersectionTypes(), ...type.getAliasTypeArguments(), ...type.getTypeArguments()]) {
    const name = t.getSymbol()?.getName();
    const decl = t.getSymbol()?.getDeclarations()[0];
    if (name && decl && !decl.getSourceFile().getFilePath().includes('/node_modules/')) return collectionName(name);
  }
  return undefined;
}

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
