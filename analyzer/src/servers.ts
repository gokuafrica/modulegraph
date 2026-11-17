/**
 * Running review servers: each one registers itself in ~/.modulegraph/servers/<pid>.json while it runs, stops by
 * itself after a period with no requests, and stops with the process that started it. `modulegraph stop` / `done`
 * find servers here and ask them to shut down over HTTP; a pid is never killed blindly.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import { join } from 'node:path';
import { homeDir } from './home.ts';

export const serversDir = join(homeDir, 'servers').replace(/\\/g, '/');
export const DEFAULT_IDLE_MINUTES = 30;

export interface ServerEntry {
  pid: number;
  port: number;
  /** Reviews it serves (empty for `modulegraph open`, which shows saved files). */
  ids: string[];
  kind: 'review' | 'open' | 'live-router';
  /** Repo the review reads (review servers). */
  repo?: string;
  startedAt: string;
  idleMinutes: number;
}

/** Header the destructive endpoints require: a web page can't send it to 127.0.0.1 without a CORS preflight. */
export const ACTION_HEADER = 'x-modulegraph';

/**
 * True for a request that may stop the server or delete a review: it carries the action header (so a web page in
 * the browser can't send it cross-origin) and is addressed to this machine by name (no DNS rebinding).
 */
export function trustedAction(req: IncomingMessage): boolean {
  return !!req.headers[ACTION_HEADER] && /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host ?? '');
}

/** Is a process with this pid running? (EPERM: it exists but belongs to someone else.) */
export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function registerServer(entry: Omit<ServerEntry, 'pid' | 'startedAt'>): void {
  mkdirSync(serversDir, { recursive: true });
  const file = join(serversDir, `${process.pid}.json`);
  writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), ...entry } satisfies ServerEntry, null, 2));
  process.on('exit', () => rmSync(file, { force: true }));
}

/** Registered servers; entries of processes that are gone are removed on the way. */
export function listServers(): ServerEntry[] {
  if (!existsSync(serversDir)) return [];
  const out: ServerEntry[] = [];
  for (const name of readdirSync(serversDir).filter((n) => /^\d+\.json$/.test(n))) {
    const file = join(serversDir, name);
    try {
      const e = JSON.parse(readFileSync(file, 'utf8')) as ServerEntry;
      if (alive(e.pid)) out.push(e);
      else rmSync(file, { force: true });
    } catch {
      rmSync(file, { force: true });
    }
  }
  return out;
}

/**
 * Stops the server after `idleMinutes` with no requests (0: never). While a review tab is visible, the UI asks for
 * the status every 5 s, so no requests means nobody is looking. Returns the function that resets the timer.
 */
export function idleShutdown(idleMinutes: number, stop: (reason: string) => void): () => void {
  if (!(idleMinutes > 0)) return () => undefined;
  const ms = Math.round(idleMinutes * 60_000);
  let timer: NodeJS.Timeout | undefined;
  const touch = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => stop(`no requests for ${formatMinutes(idleMinutes)}`), ms);
  };
  touch();
  return touch;
}

export function formatMinutes(m: number): string {
  return m >= 1 ? `${Math.round(m * 10) / 10} min` : `${Math.round(m * 60)} s`;
}

/**
 * Started by another process with an IPC channel (the modulegraph launcher, the live demo): stop when that process
 * goes away, however it went (on Windows, a hard kill of the parent leaves its children running otherwise).
 */
export function stopWithParent(stop: (reason: string) => void): void {
  if (!process.channel) return;
  process.channel.unref();
  process.on('disconnect', () => stop('the process that started it stopped'));
}

/** Graceful stop: close the server, give in-flight responses a moment, exit 0 (the registry entry goes on exit). */
export function shutdownOnSignals(server: Server, label: string): (reason: string) => void {
  let stopping = false;
  const stop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${label} stopped: ${reason}.`);
    server.close();
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 50).unref();
  };
  process.on('SIGINT', () => stop('Ctrl+C'));
  process.on('SIGTERM', () => stop('terminated'));
  return stop;
}

/** Asks a registered server to shut down, then waits for its process to end. False if it couldn't be confirmed. */
export async function stopServer(e: ServerEntry, timeoutMs = 10_000): Promise<{ ok: boolean; note?: string }> {
  // Only a server that answers with the registered pid is ours: a pid can be reused by an unrelated process.
  let health: { pid?: number } | undefined;
  try {
    health = (await (await fetch(`http://127.0.0.1:${e.port}/api/health`, { signal: AbortSignal.timeout(3000) })).json()) as { pid?: number };
  } catch {
    // not answering: busy analyzing, or gone
  }
  if (health?.pid !== e.pid) {
    return alive(e.pid)
      ? { ok: false, note: `process ${e.pid} is registered on port ${e.port} but doesn't answer as a modulegraph server; if it is one, stop it with Ctrl+C in its terminal` }
      : { ok: true, note: 'already stopped' };
  }
  try {
    await fetch(`http://127.0.0.1:${e.port}/api/shutdown`, { method: 'POST', headers: { [ACTION_HEADER]: 'stop' }, signal: AbortSignal.timeout(3000) });
  } catch {
    // the server may close the connection as it exits
  }
  const until = Date.now() + timeoutMs;
  while (alive(e.pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  return alive(e.pid) ? { ok: false, note: `process ${e.pid} did not stop within ${timeoutMs / 1000} s` } : { ok: true };
}
