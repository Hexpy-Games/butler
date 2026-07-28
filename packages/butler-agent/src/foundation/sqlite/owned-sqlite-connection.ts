import {
  Database,
  type DatabaseOptions,
  type Statement,
} from "bun:sqlite";

type FinalizableStatement = Pick<Statement, "finalize">;

export type OwnedSqliteConnection = {
  database: Database;
  close(): void;
};

export function openOwnedSqliteConnection(
  path: string,
  options?: DatabaseOptions,
): OwnedSqliteConnection {
  const database = new Database(path, options);
  const statements = new Set<FinalizableStatement>();
  const query = database.query.bind(database);
  const prepare = database.prepare.bind(database);

  database.query = ((sql: string) => track(query(sql))) as Database["query"];
  database.prepare = ((sql: string) => track(prepare(sql))) as Database["prepare"];

  let closed = false;
  return {
    database,
    close() {
      if (closed) return;
      closed = true;
      for (const statement of statements) statement.finalize();
      statements.clear();
      database.close(true);
    },
  };

  function track<T extends FinalizableStatement>(statement: T): T {
    statements.add(statement);
    return statement;
  }
}
