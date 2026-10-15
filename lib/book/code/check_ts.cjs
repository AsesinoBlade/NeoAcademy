#!/usr/bin/env node
/**
 * Type-check TypeScript/JavaScript code samples from a book with the real
 * TypeScript compiler (NeoAcademy's own `typescript` package).
 *
 * stdin:  [{ id, code, tsx }]
 * stdout: [{ id, errors: [{ code, line, message }] }]
 *
 * Samples are fragments, so errors that only mean "this name is defined
 * elsewhere" are dropped. Kept: errors that show an invented or misused API
 * (no such property / export / overload, wrong argument count) and syntax errors.
 */
const path = require('node:path');
const ts = require(require.resolve('typescript', { paths: [process.cwd()] }));

// Fragment noise: unknown names/modules defined outside the snippet,
// implicit any, unused, duplicate declarations across samples, top-level await.
const IGNORE = new Set([2304, 2552, 2580, 2582, 2307, 2792, 2591, 2503, 2451, 2393, 2300, 1375, 1378, 2686, 2688, 6133, 6196, 18003, 2306, 1208, 2875, 7016]);
const NODE_BUILTINS = new Set(require('node:module').builtinModules);

const input = JSON.parse(require('node:fs').readFileSync(0, 'utf-8'));
const results = [];

for (const sample of input) {
  const fileName = path.join(process.cwd(), `__sample_${sample.id}.${sample.tsx ? 'tsx' : 'ts'}`);
  const options = {
    // Latest standard library: a book may use any current JavaScript API.
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.esnext.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    jsx: ts.JsxEmit.Preserve,
    strict: false,
    noImplicitAny: false,
    noEmit: true,
    skipLibCheck: true,
    allowJs: true,
    esModuleInterop: true,
    types: (() => {
      try {
        require.resolve('@types/node/package.json', { paths: [process.cwd()] });
        return ['node'];
      } catch {
        return [];
      }
    })(),
    typeRoots: [path.join(process.cwd(), 'node_modules', '@types')],
  };
  const host = ts.createCompilerHost(options, true);
  const original = host.getSourceFile;
  host.getSourceFile = (name, lang, onError) =>
    path.resolve(name) === fileName ? ts.createSourceFile(name, sample.code, lang, true) : original.call(host, name, lang, onError);
  host.fileExists = ((orig) => (name) => path.resolve(name) === fileName || orig.call(host, name))(host.fileExists);

  const program = ts.createProgram([fileName], options, host);
  const source = program.getSourceFile(fileName);
  const diagnostics = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
  const errors = [];
  for (const d of diagnostics) {
    const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    if (IGNORE.has(d.code)) {
      // A missing *built-in* module (node:fsx, 'fs/promise') is a real mistake.
      const mod = d.code === 2307 && /Cannot find module '([^']+)'/.exec(message)?.[1];
      if (!(mod && (mod.startsWith('node:') || NODE_BUILTINS.has(mod.split('/')[0])) && !NODE_BUILTINS.has(mod.replace(/^node:/, '')))) continue;
    }
    // Errors about values whose type is unknown because a name came from outside
    // the snippet are noise ("Property 'x' does not exist on type '{}'").
    if (/on type '(\{\}|unknown|never)'/.test(message)) continue;
    const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0;
    errors.push({ code: d.code, line, message });
  }
  results.push({ id: sample.id, errors: errors.slice(0, 8) });
}
process.stdout.write(JSON.stringify(results));
