import { skipString } from 'some-pkg';
export function scanA(s: string) {
  const skipString = (j: number): number => j + 2;
  return skipString(0);                                          // line 4
}
export function scanB(s: string) {
  function skipString(j: number): number { return j + 3; }
  return skipString(0);                                          // line 8
}
export function scanC(s: string) { return skipString(0); }       // line 10
export function scanD(s: string) {
  const skipString = (j: number): number => j + 2;
  const skipValue = (j: number): number => skipString(j);        // line 13
  return skipValue(0);
}
export function scanE(s: string) {
  function skipString(j: number): number { return j + 3; }
  const skipValue = (j: number): number => skipString(j);        // line 18
  return skipValue(0);
}
