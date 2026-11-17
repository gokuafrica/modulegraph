/**
 * Framework adapters for the TypeScript backend.
 *
 * Most of what a framework means for the graph is data: which calls register entry points, which decorators mark
 * handlers, which library methods are side effects. The same data can be written in a service's profile
 * (`entryPoints`, `decoratorEntries`, `sinks`, …), so an agent can teach modulegraph an unknown framework without
 * code. Hooks cover what data can't say (route prefixes from `app.use('/x', router)`, Prisma's `prisma.user.*`).
 */
import type { CallExpression, NewExpression, Node, Type } from 'ts-morph';
import type { DecoratorEntryRule, EntryRule, ResponseRule, SinkRule } from '../../../config.ts';
import type { Effect } from '../../../../../schema/modulegraph.ts';

export interface Framework {
  id: string;
  name: string;
  /** Detected when the project's package.json depends on any of these. */
  packages: string[];
  /** Always on (globals such as fetch). */
  always?: boolean;
  entryPoints?: EntryRule[];
  decoratorEntries?: DecoratorEntryRule[];
  sinks?: SinkRule[];
  /** Calls whose argument is what an HTTP handler returns (`res.json(x)`). */
  responses?: ResponseRule[];
  /** Classes with these decorators are modules even if nothing injects them (`@Injectable`). */
  moduleDecorators?: string[];
  /** Classes with these decorators are wiring or data, never modules (`@Module`, `@Entity`). */
  notModuleDecorators?: string[];
  /** Classes implementing these interfaces are framework plumbing (guards, pipes, interceptors). */
  notModuleImplements?: string[];
  /** Lifecycle methods that are not operations (`onModuleInit`). */
  ignoreMethods?: string[];
  hooks?: FrameworkHooks;
}

/** Facts about one call, as the TypeScript backend resolved it. */
export interface CallSite {
  call: CallExpression | NewExpression;
  /** Declaring class, interface or type alias (`Repository`, `IRouter`, `Sender`); '' for plain functions. */
  owner: string;
  /** Method or function name; 'new' for constructor calls. */
  name: string;
  /** npm package the declaration comes from ('express', '@nestjs/common'); 'global' for built-ins; '' for project code. */
  pkg: string;
  /** `this.users` in `this.users.find()`. */
  receiver?: Node;
}

export interface HookContext {
  /** Literal value of an expression, or `<text>` when it isn't constant. */
  literal(node: Node | undefined): string;
  /** Project calls whose callee is named `name` (`use`, `register`, `setGlobalPrefix`), indexed once. */
  callsNamed(name: string): CallExpression[];
  /** Declaration a name or `a.b` refers to (through imports). */
  resolve(node: Node): Node | undefined;
  /** Table of a TypeORM entity: from an entity class reference (`Order`) or a type (`Order` in `SelectQueryBuilder<Order>`). */
  table(of: Node | Type): string | undefined;
  /** Collection of a Mongoose model the receiver is (`@InjectModel(Order.name) orders`, `Model<Order>`). */
  collection(receiver: Node): string | undefined;
}

export interface FrameworkHooks {
  /** Extra label variables for a call-registered entry point, e.g. `{prefix}` or `{topics}`. */
  entryVars?(site: CallSite, ctx: HookContext): Record<string, string> | undefined;
  /** Extra label variables for decorator entry points, e.g. Nest's global prefix. Called once per revision. */
  globalVars?(ctx: HookContext): Record<string, string>;
  /** A side effect data rules can't describe (Prisma's `prisma.<model>.<op>()`). */
  sink?(site: CallSite, ctx: HookContext): Omit<Effect, 'file' | 'line'> | undefined;
}

