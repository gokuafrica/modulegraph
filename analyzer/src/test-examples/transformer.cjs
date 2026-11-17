/**
 * Jest transformer that modulegraph puts in front of the service's own one (ts-jest, babel-jest, …) when it records
 * examples from the service's tests. It runs the service's transformer unchanged, then, for files that hold module
 * classes, appends one line that hands those classes to the recorder (setup.cjs). Options:
 *   { inner: <the service's transform entry>, from: <project folder, to resolve it>, targets: <targets JSON file> }
 */
/* eslint-disable */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();

function loadInner(spec, from) {
  const [name, options] = Array.isArray(spec) ? spec : [spec, {}];
  const req = createRequire(path.join(from, 'package.json'));
  let mod = req(name);
  if (mod && mod.default && (mod.default.process || mod.default.createTransformer)) mod = mod.default;
  // Type errors are the service's business, not the recording's: ts-jest only transpiles here.
  const opts = /ts-jest/.test(name) ? { ...options, diagnostics: false } : options;
  return typeof mod.createTransformer === 'function' ? mod.createTransformer(opts) : mod;
}

module.exports = {
  createTransformer(options) {
    const inner = loadInner(options.inner, options.from);
    const raw = fs.readFileSync(options.targets, 'utf8');
    const digest = crypto.createHash('sha1').update(raw).digest('hex');
    const byFile = new Map();
    for (const t of JSON.parse(raw)) {
      const key = norm(t.file);
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key).push(t);
    }
    const instrument = (code, file) => {
      const targets = byFile.get(norm(file));
      if (!targets) return code;
      const line = `;(function(){var r=globalThis.__modulegraphRecorder;if(!r)return;${targets
        .map((t) => `try{r.wrap(typeof exports!=='undefined'&&exports[${JSON.stringify(t.className)}],${JSON.stringify(t)})}catch(e){}`)
        .join('')}})();`;
      // Before the source map comment, so stack traces still map.
      const at = code.lastIndexOf('\n//# sourceMappingURL=');
      return at >= 0 ? `${code.slice(0, at)}\n${line}${code.slice(at)}` : `${code}\n${line}\n`;
    };
    return {
      canInstrument: inner.canInstrument,
      getCacheKey(source, file, opts) {
        const base = typeof inner.getCacheKey === 'function' ? inner.getCacheKey(source, file, opts) : crypto.createHash('sha1').update(source).digest('hex');
        return crypto.createHash('sha1').update(String(base)).update(digest).update('modulegraph-1').digest('hex');
      },
      process(source, file, opts) {
        const out = inner.process(source, file, opts);
        if (typeof out === 'string') return instrument(out, file);
        return { ...out, code: instrument(out.code, file) };
      },
    };
  },
};
