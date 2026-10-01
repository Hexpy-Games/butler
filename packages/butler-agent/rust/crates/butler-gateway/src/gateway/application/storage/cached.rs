//! Prepared-statement reuse for hot SQL. The lane connection keeps a bounded
//! statement cache (`configure` sets its capacity), so a query that runs on
//! every turn or queue poll is compiled once instead of on every call.

use rusqlite::{Connection, Params, Row};

/// Cached counterparts of `Connection::execute` and `Connection::query_row`.
/// A `Transaction` reaches them through its `Connection` deref.
pub(in crate::gateway::application) trait CachedSql {
    fn execute_cached<P: Params>(&self, sql: &str, params: P) -> rusqlite::Result<usize>;

    fn query_row_cached<T, P, F>(&self, sql: &str, params: P, map: F) -> rusqlite::Result<T>
    where
        P: Params,
        F: FnOnce(&Row<'_>) -> rusqlite::Result<T>;
}

impl CachedSql for Connection {
    fn execute_cached<P: Params>(&self, sql: &str, params: P) -> rusqlite::Result<usize> {
        self.prepare_cached(sql)?.execute(params)
    }

    fn query_row_cached<T, P, F>(&self, sql: &str, params: P, map: F) -> rusqlite::Result<T>
    where
        P: Params,
        F: FnOnce(&Row<'_>) -> rusqlite::Result<T>,
    {
        self.prepare_cached(sql)?.query_row(params, map)
    }
}
