export const keys = {
  attendance: (id: string) => `attendance:${id}`,
  roster: (id: string) => `roster:${id}`,
};

export class Store {
  get(k: string) {
    return k;
  }
}

export function load(id: string) {
  const s = new Store();
  return s.get(keys.attendance(id)) + keys.roster(id);
}
