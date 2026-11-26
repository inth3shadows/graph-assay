// The files each oracle run reads, by ORACLE_LANG (SPEC §7, "in a supported language"). Shared with
// tools/triage/lang.ts, so a fixture is tagged only with a language whose files the oracle reads (#95).
export const SOURCES = { python: /\.pyi?$/, go: /\.go$/, jvm: /\.(java|kt)$/, ts: /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/ };
