export class DatabaseConnection {
  static initialize(p: string): DatabaseConnection { return new DatabaseConnection(); }
  close(): void {}
}
