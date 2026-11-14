#!/usr/bin/env node
// A fixture's installed packages live in `node_modules.fixture/` (no ignore file or copy filter drops
// it) and every copy of a fixture puts them in place as `node_modules`; a tree that is not a fixture is
// copied as it is. Part of `graph-assay check`.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFixture } from './fixture.ts';
import { copySeed, placeFixtureInstall, FIXTURE_INSTALL } from './fixture-install.ts';

const qa = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-install-'));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
let n = 0;
try {
  const seed = path.join(tmp, 'seed');
  write(path.join(seed, 'expect.json'), '{"wrong":[],"right":[]}\n');
  write(path.join(seed, 'main.ts'), "import { f } from 'pkg';\nexport const g = () => f();\n");
  write(path.join(seed, FIXTURE_INSTALL, 'pkg', 'package.json'), '{"name":"pkg"}\n');
  write(path.join(seed, FIXTURE_INSTALL, '@s', 'q', 'index.d.ts'), 'export declare const q: number;\n');
  write(path.join(seed, 'sub', FIXTURE_INSTALL, 'x.ts'), 'export const x = 1;\n');
  // A stray install left in the fixture (an `npm i` run in it) is not the fixture's.
  write(path.join(seed, 'node_modules', 'stray', 'index.js'), '');

  const placed = (out) => {
    assert.equal(fs.readFileSync(path.join(out, 'node_modules', 'pkg', 'package.json'), 'utf8'), '{"name":"pkg"}\n');
    assert.ok(fs.existsSync(path.join(out, 'node_modules', '@s', 'q', 'index.d.ts')));
    assert.ok(!fs.existsSync(path.join(out, 'node_modules', 'stray')), 'a stray node_modules must not be copied');
    assert.ok(!fs.existsSync(path.join(out, FIXTURE_INSTALL)), 'the fixture name must not survive the copy');
    // Only the copy's root is renamed: a folder of that name deeper in is left as it is.
    assert.ok(fs.existsSync(path.join(out, 'sub', FIXTURE_INSTALL, 'x.ts')));
  };
  for (const canary of [false, true]) { const out = path.join(tmp, `fixture-${canary}`); copyFixture(seed, out, { canary }); placed(out); n++; }
  { const out = path.join(tmp, 'seed-copy'); copySeed(seed, out, (p) => path.basename(p) !== 'expect.json'); placed(out); n++; }

  // A linked root is refused (cpSync would copy the link, and placing the install would rename inside
  // the source), and the source is left exactly as it was.
  { const before = fs.readdirSync(seed).sort(); const link = path.join(tmp, 'seed-link'); fs.symlinkSync(seed, link, 'junction'); n++;
    assert.throws(() => copySeed(link, path.join(tmp, 'link-copy')), /is a symlink; pass the directory it names/);
    assert.ok(!fs.existsSync(path.join(tmp, 'link-copy')));
    assert.deepEqual(fs.readdirSync(seed).sort(), before, 'the source must be untouched'); }

  // A tree that is not a fixture (a real repo) is copied as it is, whatever its folders are called.
  const repo = path.join(tmp, 'repo');
  write(path.join(repo, 'main.ts'), "import { h } from './node_modules.fixture/h';\n");
  write(path.join(repo, FIXTURE_INSTALL, 'h.ts'), 'export const h = 1;\n');
  { const out = path.join(tmp, 'repo-copy'); copySeed(repo, out); n++;
    assert.ok(fs.existsSync(path.join(out, FIXTURE_INSTALL, 'h.ts'))); assert.ok(!fs.existsSync(path.join(out, 'node_modules'))); }

  // Nothing to place: a no-op. Both folders present: refuse rather than merge or overwrite.
  const bare = path.join(tmp, 'bare'); fs.mkdirSync(bare); placeFixtureInstall(bare); n++;
  assert.deepEqual(fs.readdirSync(bare), []);
  const both = path.join(tmp, 'both');
  write(path.join(both, FIXTURE_INSTALL, 'a.ts'), ''); write(path.join(both, 'node_modules', 'b.ts'), ''); n++;
  assert.throws(() => placeFixtureInstall(both), /both/);

  // No script copies a tree with fs.cpSync except these: every other copy goes through copySeed.
  const exempt = {
    'lib/fixture-install.ts': 'copySeed itself',
    'lib/fixture.ts': 'copyFixture, which places the install',
    'labels/questions.mjs': "the labeller's copy, which hides installs as labels/protocol.json says",
    'lib/conformance.ts': "conformance's own sources, not fixtures",
    'benchmarks/pycg.ts': 'PyCG snippets, not fixtures',
    'oracle/test/run.ts': 'oracle self-test cases, not fixtures',
    'oracle/test/regen.ts': 'oracle self-test cases, not fixtures',
  };
  const scripts = [];
  const visit = (dir) => {
    for (const e of fs.readdirSync(path.join(qa, dir), { withFileTypes: true })) {
      if (['.git', 'node_modules', '.review', 'fixtures', 'corpus'].includes(e.name)) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) visit(rel); else if ((e.name.endsWith('.mjs') || (e.name.endsWith('.ts') && (rel.startsWith('lib/') || /^(oracle\/(test\/)?|bench\/|metamorphic\/|benchmarks\/|differential\/)[^/]+\.ts$/.test(rel)))) && !/-test\.(mjs|ts)$/.test(e.name) && e.name !== 'test.mjs') scripts.push(rel); // the TypeScript scripts (tsconfig.json's include); elsewhere a .ts is an indexed source
    }
  };
  visit('');
  for (const rel of scripts) {
    if (!/\bcpSync\s*\(/.test(fs.readFileSync(path.join(qa, rel), 'utf8'))) continue;
    n++; assert.ok(rel in exempt, `${rel} copies with fs.cpSync: use copySeed (lib/fixture-install.ts) so a fixture's install is placed`);
  }
  n++; assert.match(fs.readFileSync(path.join(qa, 'labels/questions.mjs'), 'utf8'), /HIDE = new Set\([^)]*FIXTURE_INSTALL/, "labels must hide a fixture's install");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`fixture install: ${n} checks passed`);
