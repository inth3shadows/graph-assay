#!/usr/bin/env node
// tools/triage/lang.ts: which oracle indexer a fixture goes to (#95). Hermetic; part of `graph-assay check`.
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ignored, langOf } from './lang.ts';

const qa = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Oracle languages.
assert.equal(langOf(['m.go', 'go.mod', 'go.sum']), 'go');
assert.equal(langOf(['pkg/a.py', 'pyproject.toml', 'requirements.txt']), 'python');
assert.equal(langOf(['pkg/a.pyi', 'b.py']), 'python');
assert.equal(langOf(['src/a.ts', 'b.tsx', 'c.d.ts', 'package.json', 'package-lock.json']), 'ts');
assert.equal(langOf(['a.mjs', 'b.cjs', 'c.jsx']), 'ts');
// V1 (round 3): a source the oracle's own filter (oracle/sources.ts) doesn't read untags, as any other file does;
// tagged, the oracle would read none of it and record "no non-match shape".
for (const unread of ['b.pyw', 'A.PY', 'A.TS', 'x.ctsx', 'M.GO']) assert.equal(langOf([unread]), null, unread);
// No indexer wired here: untagged.
assert.equal(langOf(['A.java']), null);
assert.equal(langOf(['src/main/kotlin/K.kt']), null);
assert.equal(langOf(['Values.cs', 'Consumer.cs']), null);
assert.equal(langOf(['Sources/App/Use.swift']), null);
assert.equal(langOf(['README.md', 'expect.json']), null);
// #95: a stray script in a fixture of another language must not send it to the TS (or Python) indexer.
assert.equal(langOf(['Consumer.cs', 'wwwroot/site.js']), null);
assert.equal(langOf(['Package.swift', 'Sources/App/Use.swift', 'scripts/build.ts']), null);
assert.equal(langOf(['src/lib.rs', 'build.py']), null);
assert.equal(langOf(['app.php', 'public/app.js']), null);
// L2: any language not on the allow-list untags, including ones no deny-list named, in any case.
for (const other of ['rel.erl', 'main.tf', 'flake.nix', 'Token.sol', 'M.vb', 'a.r', 'P.astro', 'v.liquid', 'Page.cshtml', 'x.luau', 'k.cu', 'h.hxx', 'App.vue', 'A.JAVA', 'Makefile', 'artisan'])
  assert.equal(langOf(['src/a.ts', other]), null, other);
// L3: a helper script, a schema or a config is neutral, not a reason to untag.
assert.equal(langOf(['app.py', 'scripts/setup.sh', 'schema.sql', 'setup.cfg', 'tox.ini']), 'python');
assert.equal(langOf(['main.go', 'run.bash', 'config.yaml']), 'go');
assert.equal(langOf(['src/a.ts', 'build.sh', '.github/ci.yml']), 'ts');
// L1: installed packages and codegraph's data are not the fixture's sources, whatever they ship.
assert.equal(langOf(['src/a.ts', 'node_modules.fixture/pkg/binding.c', 'node_modules.fixture/pkg/Comp.vue', 'node_modules.fixture/pkg/x.h']), 'ts');
assert.equal(langOf(['src/a.ts', 'node_modules/pkg/index.js', 'node_modules/pkg/native.cc']), 'ts');
assert.equal(langOf(['a.py', '.codegraph/codegraph.db']), 'python');
assert.equal(langOf(['a.py', 'sub\\node_modules\\pkg\\x.c']), 'python');
assert.equal(langOf(['node_modules.fixture/pkg/index.js']), null);
// V2 (round 3): dot entries and __pycache__ are local junk, not sources (the oracle's own walk drops dot entries).
assert.equal(langOf(['a.py', '__pycache__/a.cpython-312.pyc', '.venv/lib/x.so', '.DS_Store', '.gitignore', '.env', '.nvmrc', '.git/HEAD']), 'python');
assert.equal(langOf(['.hidden/a.py']), null);
// V3 (round 3): more neutral files.
assert.equal(langOf(['pkg/a.py', 'pkg/py.typed']), 'python');
assert.equal(langOf(['main.go', 'go.work', 'go.work.sum']), 'go');
assert.equal(langOf(['src/a.ts', 'index.html', 'style.css', 'dist/a.js.map', 'settings.jsonc']), 'ts');
// L5: sources in two oracle languages have no single indexer.
assert.equal(langOf(['main.go', 'tools/gen.py']), null);
assert.equal(langOf(['app.py', 'static/app.js']), null);

// L4: every committed fixture's language, pinned (not "unchanged since the last rule"), so a rule change that
// moves one fails here and a new fixture states its language on purpose.
const expected: Record<string, 'go' | 'python' | 'ts' | null> = {};
const pin = (lang: 'go' | 'python' | 'ts' | null, names: string) => {
  for (const n of names.split(/\s+/).filter(Boolean)) { assert.ok(!(n in expected), `${n} pinned twice`); expected[n] = lang; }
};
pin('ts', `a b c issue-2944 issue-2946 issue-2947 issue-2948 issue-2949 issue-2951 issue-2952 issue-2953 issue-2954 issue-2962
  issue-2964 issue-2966 issue-2967 issue-2973 issue-2974 issue-3271 issue-3422 issue-3429 issue-3443 issue-3444 issue-3473
  n5-ts-barrel-member pr-2754 pr-2800 t1-ts-global-builtin t2-ts-typed-instance-member`);
pin('python', `issue-2957 issue-2958 issue-2963 issue-3430 issue-3445 issue-3446 issue-3470 m1-py-super m2-py-method-return-local
  n1-py-local-import n2-py-comprehension n3-py-enclosing-local n4-py-builtin p1 p3 p4 p5-py-stdlib-import`);
pin('go', 'g1-go-new-receiver issue-3447 issue-3448');
pin(null, `issue-2975 issue-2976 j1-java-overload java-fq-static-receiver java-typed-var-wildcard kmp-22 laravel-route-fq-class
  laravel-route-group-use laravel-route-namespace-use pr-3132 pr-3206 pr-3262`);
const root = path.join(qa, 'fixtures', 'oracle-candidates');
const names = fs.readdirSync(root).filter((n) => fs.existsSync(path.join(root, n, 'expect.json')));
assert.ok(names.length > 50, `only ${names.length} fixtures found`);
for (const n of Object.keys(expected)) assert.ok(names.includes(n), `${n}: pinned in tools/triage/lang-test.ts but no such fixture`);
for (const n of names) {
  assert.ok(n in expected, `${n}: add its language to the pinned table in tools/triage/lang-test.ts`);
  const dir = path.join(root, n);
  const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => !ignored(f) && fs.statSync(path.join(dir, f)).isFile());
  assert.equal(langOf(files), expected[n], `${n}: language`);
}
console.log(`lang: ${names.length} fixtures pinned, allow-list cases hold`);
