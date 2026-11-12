export class Scene {
  cache = { list: [] as number[] };

  a() {
    this.cache.list.push(1);
  }
}
