#![allow(dead_code, clippy::unwrap_used, reason = "test helpers")]
use butler_canon::{store::*, work_schema, work_types::*};
use rusqlite::Connection;
use serde_json::json;
pub(crate) fn db() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    work_schema::ensure(&db).unwrap();
    db
}
pub(crate) fn context() -> Context {
    Context {
        now: 100,
        actor: json!({"person":"tester"}),
    }
}
pub(crate) fn work(db: &mut Connection, id: &str) {
    let tx = Transaction::new(db.transaction().unwrap()).unwrap();
    create_work(
        &tx,
        &context(),
        &NewWork {
            id: id.into(),
            project_id: "project".into(),
            title: id.into(),
            description: String::new(),
            origin: Origin::Chat,
        },
        &Registration::Canon(UserAct::new("tester")),
    )
    .unwrap();
    tx.commit().unwrap();
}
