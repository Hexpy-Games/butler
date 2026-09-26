use rusqlite::{Connection, OpenFlags};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

#[derive(Clone)]
pub(super) struct Label {
    pub(super) title: Option<String>,
    pub(super) kind: String,
}

pub(super) fn read(data_root: &Path, ids: &[String]) -> (HashMap<String, Label>, Vec<String>) {
    let mut labels = HashMap::new();
    let mut diagnostics = Vec::new();
    if ids.is_empty() {
        return (labels, Vec::new());
    }
    let path = [
        data_root.join("app-server/butler-client.sqlite"),
        data_root.join("app.sqlite"),
    ]
    .into_iter()
    .find(|path| path.exists());
    let Some(path) = path else {
        return (labels, Vec::new());
    };
    let operation = || -> rusqlite::Result<()> {
        let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let columns = db
            .prepare("PRAGMA table_info(chats)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if !columns
            .iter()
            .any(|column| column == "conversation_session_id")
        {
            return Ok(());
        }
        let mut statement =
            db.prepare("SELECT title,kind FROM chats WHERE conversation_session_id=?1")?;
        for id in ids {
            let rows = statement
                .query_map([id], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let distinct = rows.into_iter().collect::<HashSet<_>>();
            if distinct.len() > 1 {
                if diagnostics.is_empty() {
                    diagnostics.push("catalog_conflict".into());
                }
                continue;
            }
            if let Some((title, kind)) = distinct.into_iter().next() {
                labels.insert(
                    id.clone(),
                    Label {
                        title,
                        kind: if kind.as_deref() == Some("chat")
                            || kind.as_deref() == Some("project")
                        {
                            kind.expect("recognized kind")
                        } else {
                            "unknown".into()
                        },
                    },
                );
            }
        }
        Ok(())
    };
    match operation() {
        Ok(()) => (labels, diagnostics),
        Err(_) => {
            if !diagnostics.iter().any(|text| text == "catalog_unavailable") {
                diagnostics.push("catalog_unavailable".into());
            }
            (labels, diagnostics)
        }
    }
}
