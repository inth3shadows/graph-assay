export interface Iface {
  run(x: number): number;
}

export interface Box<T> {
  v: T;
}

export interface Inner<T> {
  w: T;
}

export const impl: Iface = {
  run(x) {
    return x;
  },
};

export function viaIface(x: Iface) {
  return x.run(1);
}

export function generic<P extends Box<Inner<string>>>(p: P) {
  return p;
}

export function direct() {
  return viaIface(impl) + impl.run(2);
}

export class Impl implements Iface {
  run(x: number) {
    return x + 1;
  }
}
