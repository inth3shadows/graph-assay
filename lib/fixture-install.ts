// No imports beyond node: scripts copied into a test's minimal tree (metamorphic, modes) can load it.
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A fixture whose bug depends on installed packages keeps them in `node_modules.fixture/` at its root,
 * a name no ignore file or copy filter treats as `node_modules`. A copy of a fixture puts it in place
 * as `node_modules`. A fixture is a directory holding `expect.json`; any other tree is copied as it is.
 */
export const FIXTURE_INSTALL = 'node_modules.fixture';

export const isFixture = (dir: string): boolean => fs.existsSync(path.join(dir, 'expect.json'));

/** Rename `<dir>/node_modules.fixture` to `<dir>/node_modules`. Only call it on a copy of a fixture. */
export function placeFixtureInstall(dir: string): void {
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
 * `filter` keeps a path when true, as fs.cpSync's filter.
 */
export function copySeed(src: string, dst: string, filter: (p: string) => boolean = () => true): void {
  copyTree(src, dst, filter, false);
}

/**
 * A repo copied for a differ (differential/) to index: everything but `.codegraph/`, as copySeed copies it.
 * `node_modules/` stays, since codegraph resolves imports against installed packages (#15). Links are copied
 * as written (fs.cpSync otherwise makes a relative link absolute into `src`), so an install's relative
 * `.bin` and workspace links lead into the copy, which is all the container sandbox mounts. A relative link
 * out of the repo resolves from the copy's location, so it usually dangles (on the host backends it could
 * name a path beside the temp dir); a link naming `node_modules.fixture/` dangles once the install is
 * placed. An absolute link still names its old target.
 */
export function copyRepo(src: string, dst: string): void {
  // a repo named through a link is copied from the dir it names (copyTree refuses a linked root)
  copyTree(fs.realpathSync(src), dst, (p) => path.basename(p) !== '.codegraph', true);
}

function copyTree(src: string, dst: string, filter: (p: string) => boolean, verbatimSymlinks: boolean): void {
  // cpSync copies a linked root as the link, and placing the install in that "copy" would rename inside
  // the source. Refuse it, as copyFixture refuses any link: pass the tree's real path.
  if (fs.lstatSync(src).isSymbolicLink()) throw new Error(`${src} is a symlink; pass the directory it names (${fs.readlinkSync(src)})`);
  const fixture = isFixture(src);
  const stray = path.join(src, 'node_modules');
  fs.cpSync(src, dst, { recursive: true, verbatimSymlinks, filter: (p) => filter(p) && !(fixture && p === stray) });
  if (fixture) placeFixtureInstall(dst);
}
