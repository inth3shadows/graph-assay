// The snapshot and expectation contracts as TypeScript types, written once. They mirror
// schema/snapshot.v1.json and schema/expect.v1.json; the schemas stay the contract, and
// lib/snapshot.ts and lib/expect.ts validate it at runtime. Type-only: Node strips this file to nothing.

/** A subject's identity: which tool, which build, which adapter bytes. */
export interface Subject {
  name: string;
  version?: string | null;
  /** adapter and shared snapshot-contract implementation hash; absent on legacy snapshots */
  adapterSha256?: string;
  config?: Record<string, unknown>;
}

export interface Capabilities {
  siteLines: boolean;
  siteColumns: boolean;
  columnEncoding?: string | null;
  unresolved: boolean;
  provenance: boolean;
  edgeKinds?: string[];
}

export interface SnapshotFile {
  path: string;
  language?: string | null;
}

export interface SnapshotNode {
  id: string;
  kind: string;
  name: string;
  qname?: string | null;
  file: string;
  language?: string | null;
  start: number;
  end: number;
}

export interface SnapshotEdge {
  kind: string;
  src: string;
  dst: string;
  line?: number | null;
  col?: number | null;
  ref?: string | null;
  resolvedBy?: string | null;
  /** null = extracted / resolved; heuristic = guessed or synthesized */
  provenance?: string | null;
}

export interface Unresolved {
  src?: string | null;
  file: string;
  line: number;
  col?: number | null;
  name: string;
  kind: string;
}

/** graph-assay/snapshot@1: what a subject tool's index holds, in a tool-neutral shape. */
export interface Snapshot {
  schema: 'graph-assay/snapshot@1';
  subject: Subject;
  capabilities: Capabilities;
  files: SnapshotFile[];
  nodes: SnapshotNode[];
  edges: SnapshotEdge[];
  unresolved: Unresolved[];
}

/** One edge an expectation names: `to` is `<target file>:<target qualified name>`. */
export interface ExpectEdge {
  from: string;
  fromFile?: string;
  kind: string;
  to: string;
  toLine?: number;
}

/** graph-assay/expect@1: a fixture's expect.json. */
export interface Expectation {
  issue: number | null;
  note?: string;
  wrong: ExpectEdge[];
  right: ExpectEdge[];
}
