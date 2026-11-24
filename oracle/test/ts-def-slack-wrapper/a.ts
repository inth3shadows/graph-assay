const wrap = <T>(f: T): T => f;

export const Wrapped = wrap(
  function Wrapped(n: number): number { return n; },
);

export class Panel {
  private handler =
    (n: number): number => n + 1;
  run(): number { return this.handler(1); }
}

export function use(): number {
  return Wrapped(1);
}
