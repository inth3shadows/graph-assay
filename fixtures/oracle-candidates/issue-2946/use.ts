import { DatabaseConnection } from './db';
export function run() {
  const writer = DatabaseConnection.initialize('x');
  writer.close();
}
export function renamed() {
  const conn = DatabaseConnection.initialize('x');
  conn.close();
}
export function annotated() {
  const writer: DatabaseConnection = DatabaseConnection.initialize('x');
  writer.close();
}
export function viaNew() {
  const writer = new DatabaseConnection();
  writer.close();
}
export function chained() {
  DatabaseConnection.initialize('x').close();
}
