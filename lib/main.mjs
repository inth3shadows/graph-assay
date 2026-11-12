// Is this module the script node was started with? Robust to spaces, `%`, non-ASCII and symlinks
// in the checkout path, where comparing import.meta.url with `file://${argv[1]}` silently fails.
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMain(moduleUrl) {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(fileURLToPath(moduleUrl)) === fs.realpathSync(process.argv[1]); } catch { return false; }
}
