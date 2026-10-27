//! Indexed App identity resolution; names never silently select among duplicates.
use super::*;
use crate::gateway::ApplicationFuture;
use serde_json::json;

pub(in crate::gateway::application) fn resolve(
    app: AppApplication,
    reference: String,
) -> ApplicationFuture<Value> {
    Box::pin(async move {
        let reference = butler_core::public_text::trim_js_whitespace(&reference).to_owned();
        let matches = app
            .storage
            .read(move |db| lookup(db, &reference))
            .await
            .map_err(app_error)?;
        match matches.as_slice() {
            [project] => Ok(project.clone()),
            [] => Err(error(404, "project_not_found", "Project not found.")),
            _ => Err(error(
                409,
                "project_reference_ambiguous",
                "Use the project id; this name matches multiple projects.",
            )),
        }
    })
}
fn lookup(db: &Connection, reference: &str) -> Result<Vec<Value>, AppStorageError> {
    if let Some(project) = rows::active_by_id(db, reference)? {
        let id = rows::id(&project).to_owned();
        return Ok(vec![
            json!({"id":id,"display_name":rows::summary(project, None).display_name}),
        ]);
    }
    let mut statement = db
        .prepare(
            "SELECT id,display_name FROM projects INDEXED BY projects_active_name_idx WHERE display_name=?1 AND archived=0 LIMIT 2",
        )
        .map_err(AppStorageError::sqlite)?;
    statement
        .query_map([reference], |row| {
            Ok(json!({
                "id":row.get::<_, String>(0)?, "display_name":row.get::<_, String>(1)?
            }))
        })
        .map_err(AppStorageError::sqlite)?
        .map(|row| row.map_err(AppStorageError::sqlite))
        .collect()
}
