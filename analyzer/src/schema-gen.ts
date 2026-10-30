/** Generates schema/modulegraph.schema.json from schema/modulegraph.ts so other producers (agents, other-language analyzers) can validate. */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Node, Project, type TypeNode } from 'ts-morph';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../../schema/modulegraph.ts');
const file = new Project({ skipAddingFilesFromTsConfig: true }).addSourceFileAtPath(source);

type Json = Record<string, unknown>;

function convert(node: TypeNode | undefined): Json {
  if (!node) return {};
  if (Node.isLiteralTypeNode(node)) {
    const lit = node.getLiteral();
    return Node.isStringLiteral(lit) ? { const: lit.getLiteralValue() } : {};
  }
  if (Node.isUnionTypeNode(node)) {
    const parts = node.getTypeNodes().map(convert);
    if (parts.every((p) => 'const' in p)) return { type: 'string', enum: parts.map((p) => p.const) };
    return { anyOf: parts };
  }
  if (Node.isArrayTypeNode(node)) return { type: 'array', items: convert(node.getElementTypeNode()) };
  if (Node.isTypeLiteral(node)) return objectOf(node.getProperties());
  if (Node.isTypeReference(node)) {
    const name = node.getTypeName().getText();
    const args = node.getTypeArguments();
    if (name === 'Record') return { type: 'object', additionalProperties: convert(args[1]) };
    if (name === 'Omit') return convert(args[0]);
    return { $ref: `#/definitions/${name}` };
  }
  const text = node.getText();
  if (text === 'string' || text === 'number' || text === 'boolean') return { type: text };
  return {};
}

function objectOf(props: { getName(): string; getTypeNode(): TypeNode | undefined; hasQuestionToken(): boolean; getJsDocs?(): { getDescription(): string }[] }[]): Json {
  const properties: Json = {};
  const required: string[] = [];
  for (const p of props) {
    const schema = convert(p.getTypeNode());
    const doc = p.getJsDocs?.().map((d) => d.getDescription().trim()).join(' ');
    properties[p.getName()] = doc ? { ...schema, description: doc } : schema;
    if (!p.hasQuestionToken()) required.push(p.getName());
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

const definitions: Json = {};
for (const alias of file.getTypeAliases()) definitions[alias.getName()] = convert(alias.getTypeNode());
for (const iface of file.getInterfaces()) {
  const own = objectOf(iface.getProperties());
  const bases = iface.getExtends().map((e) => ({ $ref: `#/definitions/${e.getExpression().getText()}` }));
  definitions[iface.getName()] = bases.length ? { allOf: [...bases, { ...own, additionalProperties: true }] } : own;
}

const schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://modulegraph.dev/schema/modulegraph-v1.json',
  title: 'modulegraph/v1',
  description: 'Module-level review graph: modules, operations, entry points, scopes (flows), findings. Generated from schema/modulegraph.ts.',
  $ref: '#/definitions/ModuleGraph',
  definitions,
};
const out = resolve(here, '../../schema/modulegraph.schema.json');
writeFileSync(out, `${JSON.stringify(schema, null, 2)}\n`);
console.log(`wrote ${out} (${Object.keys(definitions).length} definitions)`);
