export const twice =
  (n: number): number => n * 2;

export const thrice =

  (n: number): number => n * 3;

export function run(): number {
  return twice(3) + thrice(2);
}
