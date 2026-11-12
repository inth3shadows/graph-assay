import { m } from './lib';

export class Widget {
  m() {
    return 2;
  }

  run() {
    return this.m() + m();
  }
}
