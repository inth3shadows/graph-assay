import { g } from './dup';

export const viaArrow = () => g(3);

export function viaCallback(xs: number[]) {
  return xs.map((x) => g(x));
}
