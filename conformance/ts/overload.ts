export function pick(x: string): string;
export function pick(x: number): number;
export function pick(x: string | number) {
  return x;
}

export function usePick() {
  return pick(1);
}
