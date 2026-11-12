import { findAll, getFactor } from './lib';
export class Tools {
  run(q: string) { return this.findAll(q); }                               // line 3
  private findAll(q: string): string[] { return findAll(q).concat('own'); } // line 4
  size(w: number) { return this.getFactor(w); }                            // line 5
  private getFactor = (w: number): number => getFactor(w) * 2;             // line 6
}
