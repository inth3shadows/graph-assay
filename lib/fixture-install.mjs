// No imports beyond node: scripts copied into a test's minimal tree (metamorphic, modes) can load it.
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A fixture whose bug depends on installed packages keeps them in `node_modules.fixture/` at its root,
 * a name no ignore file or copy filter treats as `node_modules`. Every copy of a fixture puts it in place
 * as `node_modules`; only a copy's root is looked at, so a real repo's folders are never renamed.
 */
export const FIXTURE_INSTALL = 'node_modules.fixture';
export function placeFixtureInstall(dir) {
  const from = path.join(dir, FIXTURE_INSTALL);
  if (!fs.existsSync(from)) return;
  const to = path.join(dir, 'node_modules');
  if (fs.existsSync(to)) throw new Error(`${dir}: both ${FIXTURE_INSTALL}/ and node_modules/ exist`);
  fs.renameSync(from, to);
}
