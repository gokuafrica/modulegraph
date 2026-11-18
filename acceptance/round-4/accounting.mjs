/**
 * An independent list of the calls a static reader can't take at face value, read straight from the source with the
 * TypeScript parser (syntax only, no modulegraph code): what modulegraph's `--explain` must account for.
 *
 *   value-call:    a call through a parameter or a local variable (`query(queryRunner)`, `operation()`)
 *   passed-fn:     a function literal handed to a call that may run it later or elsewhere (`startTransaction(ds, [(qr) => …])`,
 *                  `retry(() => …)`, `catchError((e) => …)`), not to an array method that runs it in place
 *
 * Only calls inside the given operations' line ranges are listed. No names of any service are in here.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** Array methods run their callback in place, once per element, right there: no question where its steps go. */
const IN_PLACE = new Set(['map', 'forEach', 'filter', 'reduce', 'reduceRight', 'some', 'every', 'find', 'findIndex', 'findLast', 'flatMap', 'sort']);

export function candidates(mgDir, projectDir, ops) {
  const ts = createRequire(join(mgDir, 'analyzer/package.json'))('typescript');
  const byFile = new Map();
  for (const op of ops) byFile.set(op.file, [...(byFile.get(op.file) ?? []), op]);
  const out = [];
  for (const [file, fileOps] of byFile) {
    let text;
    try { text = readFileSync(join(projectDir, file), 'utf8'); } catch { continue; }
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
    const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const opAt = (line) => fileOps.find((o) => line >= o.line && line <= o.endLine);
    /** Names bound as parameters or local variables in the functions around `node`. */
    const localNames = (node) => {
      const names = new Set();
      for (let p = node.parent; p; p = p.parent) {
        if (ts.isFunctionLike(p)) for (const prm of p.parameters ?? []) if (ts.isIdentifier(prm.name)) names.add(prm.name.text);
        if (ts.isBlock(p) || ts.isSourceFile(p)) {
          for (const st of p.statements ?? []) {
            if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.add(d.name.text);
            if (ts.isForOfStatement(st) && ts.isVariableDeclarationList(st.initializer)) for (const d of st.initializer.declarations) if (ts.isIdentifier(d.name)) names.add(d.name.text);
          }
        }
        if (ts.isForOfStatement(p) && ts.isVariableDeclarationList(p.initializer)) for (const d of p.initializer.declarations) if (ts.isIdentifier(d.name)) names.add(d.name.text);
        if (ts.isClassDeclaration(p)) break;
      }
      return names;
    };
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const line = lineOf(node);
        const op = opAt(line);
        if (op) {
          // value-call: callee is a bare identifier bound locally (a parameter, a const holding a function, a loop variable).
          if (ts.isIdentifier(node.expression) && localNames(node).has(node.expression.text)) {
            out.push({ op: op.id, kind: 'value-call', line, text: node.getText(sf).slice(0, 80) });
          }
          // passed-fn: function literals among the arguments (directly, or inside an array literal argument).
          const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : '';
          if (!IN_PLACE.has(callee)) {
            const fns = node.arguments.flatMap((a) => (ts.isArrayLiteralExpression(a) ? [...a.elements] : [a])).filter((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
            for (const fn of fns) out.push({ op: op.id, kind: 'passed-fn', line: lineOf(fn), text: `${callee}(… ${fn.getText(sf).slice(0, 60)} …)` });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}
