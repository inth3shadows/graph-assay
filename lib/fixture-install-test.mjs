#!/usr/bin/env node
// A fixture's installed packages live in `node_modules.fixture/` (no ignore file or copy filter
// drops it) and every copy of a fixture puts them in place as `node_modules`. Part of `graph-assay check`.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFixture, placeFixtureInstall, FIXTURE_INSTALL } from './fixture.mjs';

const qa = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-install-'));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
let n = 0;
try {
  const seed = path.join(tmp, 'seed');
  write(path.join(seed, 'main.ts'), "import { f } from 'pkg';\nexport const g = () => f();\n");
  write(path.join(seed, FIXTURE_INSTALL, 'pkg', 'package.json'), '{"name":"pkg"}\n');
  write(path.join(seed, FIXTURE_INSTALL, '@s', 'q', 'index.d.ts'), 'export declare const q: number;\n');
  write(path.join(seed, 'sub', FIXTURE_INSTALL, 'x.ts'), 'export const x = 1;\n');

  // copyFixture puts the install in place, plain and canary alike, scoped folders included.
  for (const canary of [false, true]) {
    const out = path.join(tmp, `copy-${canary}`); copyFixture(seed, out, { canary }); n++;
    assert.equal(fs.readFileSync(path.join(out, 'node_modules', 'pkg', 'package.json'), 'utf8'), '{"name":"pkg"}\n');
    assert.ok(fs.existsSync(path.join(out, 'node_modules', '@s', 'q', 'index.d.ts')));
    assert.ok(!fs.existsSync(path.join(out, FIXTURE_INSTALL)), 'the fixture name must not survive the copy');
    // Only the copy's root is renamed: a folder of that name deeper in is left as it is.
    assert.ok(fs.existsSync(path.join(out, 'sub', FIXTURE_INSTALL, 'x.ts')));
  }

  // Nothing to place: a no-op. Both folders present: refuse rather than merge or overwrite.
  const bare = path.join(tmp, 'bare'); fs.mkdirSync(bare); placeFixtureInstall(bare); n++;
  assert.deepEqual(fs.readdirSync(bare), []);
  const both = path.join(tmp, 'both');
  write(path.join(both, FIXTURE_INSTALL, 'a.ts'), ''); write(path.join(both, 'node_modules', 'b.ts'), ''); n++;
  assert.throws(() => placeFixtureInstall(both), /both/);

  // Every script that copies a fixture or seed for a subject to index puts the install in place.
  for (const file of ['differential/builds.mjs', 'differential/modes.mjs', 'differential/shadow.mjs', 'metamorphic/run.mjs',
    'labels/questions.mjs', 'tools/triage/tag-fixtures.mjs']) {
    n++; assert.match(fs.readFileSync(path.join(qa, file), 'utf8'), /placeFixtureInstall\(/, `${file} copies without placing the install`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`fixture install: ${n} checks passed`);
