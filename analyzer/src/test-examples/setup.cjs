/**
 * Jest `setupFilesAfterEnv` file that modulegraph adds when it records examples from a service's own tests
 * (test-examples.ts). Every test is one case: each module operation the test calls (instrumented by transformer.cjs
 * as Jest loads the service's files) records its first input and output in that test. At the end of the spec file the
 * cases go to MODULEGRAPH_EXAMPLES_DIR as JSON. Nothing in the service changes; tests pass or fail as they would.
 */
/* eslint-disable */
const fs = require('fs');
const path = require('path');

const outDir = process.env.MODULEGRAPH_EXAMPLES_DIR;
const state = { cases: [], current: undefined };

/** JSON-safe, size-bounded copy so examples stay readable in a node (the same as the scenario runner's). */
function snapshot(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value !== 'object') {
    if (typeof value === 'function') return value._isMockFunction ? '[jest.fn()]' : `[function ${value.name || ''}]`.replace(' ]', ']');
    if (typeof value === 'bigint') return String(value);
    return typeof value === 'string' && value.length > 120 ? `${value.slice(0, 117)}…` : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `<Buffer ${value.length} bytes>`;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (depth > 4) return Array.isArray(value) ? '[…]' : '{…}';
  if (Array.isArray(value)) {
    const items = value.slice(0, 5).map((v) => snapshot(v, depth + 1, seen));
    return value.length > 5 ? [...items, `…${value.length - 5} more`] : items;
  }
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 24)) out[k] = snapshot(v, depth + 1, seen);
  return out;
}

function failure(err) {
  const status = typeof err?.getStatus === 'function' ? err.getStatus() : err?.status ?? err?.statusCode;
  return { error: String(err), ...(typeof status === 'number' ? { status } : {}) };
}

function record(c, target, args, result) {
  if (c.calls[target.opId]) return;
  const input = {};
  target.params.forEach((name, i) => (input[name] = snapshot(args[i])));
  c.calls[target.opId] = { input, ...(result.error ? { error: result.error, ...(result.status ? { status: result.status } : {}) } : { output: snapshot(result.output) }) };
}

globalThis.__modulegraphRecorder = {
  /** Wraps one method of a class loaded by the test: records the call in the running test, then behaves as before. */
  wrap(cls, target) {
    const proto = cls && cls.prototype;
    const original = proto && proto[target.method];
    if (typeof original !== 'function' || original.__modulegraph) return;
    const wrapped = function (...args) {
      const c = state.current;
      if (!c) return original.apply(this, args);
      try {
        const out = original.apply(this, args);
        if (out && typeof out.then === 'function') {
          return out.then(
            (value) => (record(c, target, args, { output: value }), value),
            (err) => {
              record(c, target, args, failure(err));
              throw err;
            },
          );
        }
        record(c, target, args, { output: out });
        return out;
      } catch (err) {
        record(c, target, args, failure(err));
        throw err;
      }
    };
    wrapped.__modulegraph = true;
    Object.defineProperty(wrapped, 'name', { value: original.name });
    proto[target.method] = wrapped;
  },
};

beforeEach(() => {
  const s = expect.getState();
  state.current = { label: s.currentTestName || 'test', calls: {} };
  state.cases.push(state.current);
});

afterEach(() => {
  state.current = undefined;
});

afterAll(() => {
  if (!outDir) return;
  const testPath = expect.getState().testPath || 'unknown';
  const cases = state.cases.filter((c) => Object.keys(c.calls).length);
  const name = Buffer.from(testPath).toString('base64url').slice(-80);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ testPath, tests: state.cases.length, cases }));
});
