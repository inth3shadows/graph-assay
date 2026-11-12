export interface Matcher {
  (p: string): boolean;
  snapshot?: () => (p: string) => boolean;
}

export function take(fn: (p: string) => boolean) {
  const matcher = fn as Matcher;
  return matcher.snapshot ? matcher.snapshot() : matcher;
}
