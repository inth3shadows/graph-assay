import { find } from './lib';

export class Handler {
  run(s: string): string {
    return this.find(s);
  }

  private find(s: string): string {
    return find(s);
  }
}
