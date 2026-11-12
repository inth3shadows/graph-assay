export class Scene {
  cache = { list: [] as number[], names: [] as string[] };
  a() { this.cache.list.push(1); }
  b(t: string) { return this.cache.names.includes(t); }
}
export function c(o: { data: number[] }) { o.data.push(1); }
export function d(w: { dbg?: { data: number[] } }) { w.dbg?.data.push(1); }
export function e(list: number[]) { list.push(1); }
