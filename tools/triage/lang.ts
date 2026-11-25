// Which oracle indexer a fixture's sources go to (tools/triage/tag-fixtures.ts), or null when the oracle has
// none wired here. A fixture with any source in a language the oracle doesn't index is null, even when it also
// ships a TS/JS or Python file (a build script, a webpack config): tagging it from that one file would record
// the wrong shapes, or none, and count it as "produces no shape" instead of untagged (#95).
const NO_ORACLE = /\.(java|kt|kts|php|cs|swift|rs|rb|c|cc|cpp|cxx|h|hh|hpp|m|mm|scala|dart|lua|ex|exs|hs|pas|dpr|dfm|cj|zig|nim|odin|cds|scad|sql|rego|groovy|gvy|magik|gd|tscn|v|sv|fs|fsi|fsx|cr|sh|bash|qml|ets|vue|svelte)$/;

export const langOf = (files: string[]): 'go' | 'python' | 'ts' | null =>
  files.some((f) => NO_ORACLE.test(f)) ? null
    : files.some((f) => f.endsWith('.go')) ? 'go'
      : files.some((f) => f.endsWith('.py')) ? 'python'
        : files.some((f) => /\.[cm]?[jt]sx?$/.test(f)) ? 'ts'
          : null;
