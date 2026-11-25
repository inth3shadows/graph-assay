export function traceFunction(opts: object) { return <T>(fn: T) => fn; }
export function withRetry<T>(fn: T) { return fn; }
