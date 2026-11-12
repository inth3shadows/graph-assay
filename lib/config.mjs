// Every path graph-assay uses, in one place. Precedence: environment variable, then
// ~/.config/graph-assay/config.json (keys as below), then this machine's defaults.
//
//   node lib/config.mjs [key]   prints one value (or all as JSON), for shell scripts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isMain } from './main.mjs';

const home = os.homedir();
const xdgCache = process.env.XDG_CACHE_HOME ?? path.join(home, '.cache');
const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
const configFile = path.join(xdgConfig, 'graph-assay', 'config.json');

let file = {};
try { file = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (e) {
  // No file means defaults; a file that does not parse is a mistake worth saying out loud.
  if (e.code !== 'ENOENT') console.error(`graph-assay: ignoring ${configFile}: ${e.message}`);
}

// An empty variable counts as unset.
const pick = (env, key, dflt) => process.env[env] || file[key] || dflt;
const oracleCache = pick('ORACLE_CACHE', 'oracleCache', path.join(xdgCache, 'graph-assay', 'oracle'));
const tools = pick('ORACLE_TOOLS', 'tools', path.join(home, '.local/share/graph-assay/tools'));

export const config = {
  configFile,
  /** codegraph.js under test when none is given */
  codegraphBuild: pick('CODEGRAPH_BUILD', 'codegraphBuild', path.join(xdgCache, 'graph-assay', 'subjects', 'codegraph', 'dist/bin/codegraph.js')),
  oracleCache,
  /** oracle work dirs, w-<name>/ */
  work: pick('ORACLE_WORK', 'work', path.join(oracleCache, 'work')),
  scipCache: pick('ORACLE_SCIP_CACHE', 'scipCache', path.join(oracleCache, 'scip')),
  baselines: pick('ORACLE_BASELINES', 'baselines', path.join(oracleCache, 'baselines')),
  builds: pick('ORACLE_BUILDS', 'builds', path.join(oracleCache, 'builds')),
  bench: pick('ORACLE_BENCH', 'bench', path.join(oracleCache, 'bench')),
  /** installs of other subject tools (e.g. code-graph-rag's venv) */
  subjects: pick('CGQA_SUBJECTS', 'subjects', path.join(xdgCache, 'graph-assay', 'subjects')),
  tools,
  scipBin: pick('SCIP_BIN', 'scipBin', path.join(tools, 'scip')),
};

if (isMain(import.meta.url)) {
  const key = process.argv[2];
  if (!key) console.log(JSON.stringify(config, null, 1));
  else if (key in config) console.log(config[key]);
  else { console.error(`unknown key ${key}; keys: ${Object.keys(config).join(', ')}`); process.exit(2); }
}
