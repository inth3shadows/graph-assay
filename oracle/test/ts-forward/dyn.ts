declare const require: (m: string) => any;

export function load() {
  const { go } = require('./lib');
  return go();
}
