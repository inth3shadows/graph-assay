import { db } from './db';

export function save() {
  return db.set(1, 2);
}
