import { stream } from './streaming';
export function handlerA(c: unknown) {
  return stream(c, async (stream) => {      // line 3
    stream.onAbort(() => {});              // line 4
    stream.write('x');                     // line 5
  });
}
export function handlerC(stream: { onAbort(f: () => void): void }) {
  stream.onAbort(() => {});
}
export function localConst() {
  const stream = { onAbort(f: () => void) {} };
  stream.onAbort(() => {});
}
export function handlerS(c: unknown) {
  return stream(c, async (s) => { s.onAbort(() => {}); });
}
export function cast() { (stream as any).onAbort(); }
