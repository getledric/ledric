export interface Migration {
  id: number;
  name: string;
  /** One or more SQL statements separated by semicolons. */
  sql: string;
}
