// No imports beyond node: scripts copied into a test's minimal tree (metamorphic, modes) can load it.
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A fixture whose bug depends on installed packages keeps them in `node_modules.fixture/` at its root,
 * a name no ignore file or copy filter treats as `node_modules`. A copy of a fixture puts it in place
 * as `node_modules`. A fixture is a directory holding `expect.json`; any other tree is copied as it is.
 */
export const FIXTURE_INSTALL = 'node_modules.fixture';

export const isFixture = (dir) => fs.existsSync(path.join(dir, 'expect.json'));

/** Rename `<dir>/node_modules.fixture` to `<dir>/node_modules`. Only call it on a copy of a fixture. */
export function placeFixtureInstall(dir) {
  const from = path.join(dir, FIXTURE_INSTALL);
  if (!fs.existsSync(from)) return;
  const to = path.join(dir, 'node_modules');
  if (fs.existsSync(to)) throw new Error(`${dir}: both ${FIXTURE_INSTALL}/ and node_modules/ exist`);
  fs.renameSync(from, to);
}

/**
 * Every script that copies a fixture or a seed for a subject to index copies it with this. A fixture
 * loses any stray `node_modules/` of its own (an `npm i` run in it, a checkout from before installs
 * were renamed) and gets its install in place.
 */
export function copySeed(src, dst, filter = () => true) {
  // A link to the tree is copied as the tree it names: cpSync would copy the link itself, and placing
  // the install in that "copy" would rename inside the source.
  const from = fs.lstatSync(src).isSymbolicLink() ? fs.realpathSync(src) : src;
  const fixture = isFixture(from);
  const stray = path.join(from, 'node_modules');
  fs.cpSync(from, dst, { recursive: true, filter: (p) => filter(p) && !(fixture && p === stray) });
  if (fixture) placeFixtureInstall(dst);
}
