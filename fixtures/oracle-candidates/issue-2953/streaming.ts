export interface StreamApi { onAbort(f: () => void): void; write(s: string): void; }
export function stream(c: unknown, cb: (s: StreamApi) => Promise<void>): Response { return null as any; }
