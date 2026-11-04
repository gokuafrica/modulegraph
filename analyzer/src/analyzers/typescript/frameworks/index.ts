import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DetectedFramework } from '../../types.ts';
import { bullmq, kafkajs, nodeCron } from './messaging.ts';
import { mongoose, prisma, typeorm } from './data.ts';
import { axios, express, fastify, fetchApi } from './http.ts';
import { nestjs } from './nestjs.ts';
import type { Framework } from './types.ts';

/** Every framework adapter the TypeScript backend knows. Add one here (and a fixture in fixtures/frameworks). */
export const frameworks: Framework[] = [nestjs, express, fastify, kafkajs, bullmq, nodeCron, typeorm, prisma, mongoose, axios, fetchApi];

/**
 * Frameworks a project uses: the profile's explicit list if it has one, else every adapter whose packages the
 * project's package.json depends on (plus always-on ones such as fetch).
 */
export function detectFrameworks(projectDir: string, explicit?: string[]): { use: Framework[]; detected: DetectedFramework[] } {
  if (explicit) {
    const unknown = explicit.filter((id) => !frameworks.some((f) => f.id === id));
    if (unknown.length) throw new Error(`unknown framework(s) ${unknown.join(', ')}; known: ${frameworks.map((f) => f.id).join(', ')}`);
    const use = frameworks.filter((f) => explicit.includes(f.id));
    return { use, detected: use.map((f) => ({ id: f.id, name: f.name, reason: 'listed in the profile' })) };
  }
  const deps = dependencies(projectDir);
  const use: Framework[] = [];
  const detected: DetectedFramework[] = [];
  for (const f of frameworks) {
    const hit = f.packages.find((p) => deps.has(p));
    if (hit || f.always) {
      use.push(f);
      if (hit) detected.push({ id: f.id, name: f.name, reason: `package.json depends on ${hit}` });
    }
  }
  return { use, detected };
}

function dependencies(projectDir: string): Set<string> {
  const file = join(projectDir, 'package.json');
  if (!existsSync(file)) return new Set();
  const pkg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, string> | undefined>;
  return new Set(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => Object.keys(pkg[k] ?? {})));
}
