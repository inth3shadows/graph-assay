// Adapter identity is a hash of implementation bytes, never an absolute install path or Git SHA.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const qa = fileURLToPath(new URL('../', import.meta.url));
const adapters = { codegraph: 'codegraph.mjs', 'code-graph-rag': 'code-graph-rag.mjs' };
export const ADAPTER_SHARED = ['lib/provenance.mjs', 'lib/config.mjs', 'lib/snapshot.mjs', 'lib/main.mjs',
  'lib/subjects/index.mjs', 'schema/snapshot.v1.json'];

/** Recompute from disk so edited adapters are identified even without a commit or .git. */
export function adapterHash(name, root = qa) {
  if (!Object.hasOwn(adapters, name)) throw new Error(`unknown adapter ${name}`);
  const files = [...ADAPTER_SHARED, `lib/subjects/${adapters[name]}`].sort();
  const hash = createHash('sha256');
  for (const file of files) {
    const content = fs.readFileSync(path.join(root, file));
    hash.update(`${file}\0${content.length}\0`).update(content);
  }
  return hash.digest('hex');
}

/** A legacy input has unknown provenance. Never stamp loaded results with today's adapter. */
export const recordedAdapterHash = (result) => result?.adapterSha256 ?? result?.subject?.adapterSha256 ?? null;
