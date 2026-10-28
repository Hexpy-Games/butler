use super::*;

pub(super) async fn detail(
    app: &AppApplication,
    id: String,
) -> Result<Value, GatewayApplicationError> {
    let language = language(app).await?;
    let mut value = app
        .dependencies
        .canon
        .proposal("get".into(), json!({"id":id,"language":language}))
        .await?;
    app.storage
        .read(move |db| {
            super::super::canon::public_sessions(db, &mut value)?;
            if let Some(id) = value["project"]["id"].as_str() {
                let name: Option<String> = db
                    .query_row("SELECT display_name FROM projects WHERE id=?1", [id], |r| {
                        r.get(0)
                    })
                    .optional()
                    .map_err(AppStorageError::sqlite)?;
                value["project"]["name"] = json!(name.unwrap_or_default());
            }
            if let Some(epics) = value["epics"].as_array_mut() {
                for epic in epics {
                    let ids = epic["attachments"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|a| a["file_id"].as_str().map(str::to_owned))
                        .collect::<Vec<_>>();
                    epic["attachments"] = super::super::canon::files::from_ids(db, &ids)?;
                }
            }
            Ok(value)
        })
        .await
        .map_err(app_error)
}
use rusqlite::OptionalExtension;
pub(super) async fn target_project(
    app: &AppApplication,
    session: &str,
    requested: Option<&str>,
) -> Result<Option<String>, GatewayApplicationError> {
    let (session, requested) = (session.to_owned(), requested.map(str::to_owned));
    app.storage.read(move |db| {
        let chat:Option<String>=db.query_row("SELECT project_id FROM chats WHERE id=?1",[session],|r|r.get(0)).map_err(AppStorageError::sqlite)?;
        if let Some(id)=requested.or(chat) {
            if super::super::projects::rows::active_by_id(db,&id)?.is_none() {
                return Err(AppStorageError::new(super::super::storage::AppStorageCode::ProjectNotFound, id));
            }
            return Ok(Some(id));
        }
        db.query_row("SELECT id FROM projects INDEXED BY projects_recent_canon WHERE archived=0 ORDER BY updated_at DESC LIMIT 1",[],|r|r.get(0)).optional().map_err(AppStorageError::sqlite)
    }).await.map_err(|error| {
        if error.code() == "project_not_found" {
            public(404, "canon_project_not_found", &format!("Project {} doesn't exist or is archived. Call canon_read (view projects) to pick one, or omit project_id to use this conversation's project.", error.message()))
        } else { app_error(error) }
    })
}
pub(super) async fn attachments(
    app: &AppApplication,
    session: &str,
    changes: &mut [Value],
) -> Result<(), GatewayApplicationError> {
    for change in changes
        .iter_mut()
        .filter(|c| matches!(c["op"].as_str(), Some("epic.create" | "epic.edit")))
    {
        let mut ids = change["attachments"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|a| field(a, "file_id"))
            .collect::<Result<Vec<_>, _>>()?;
        let old = if let Some(id) = change["id"].as_str() {
            app.dependencies
                .canon
                .execute(AppCanonRequest {
                    delegate: None,
                    resource: AppCanonResource::Epic,
                    id: id.into(),
                    input: None,
                })
                .await?["description"]
                .as_str()
                .unwrap_or_default()
                .to_owned()
        } else {
            String::new()
        };
        let mut description = change["description"].as_str().unwrap_or(&old).to_owned();
        let retained = butler_canon::store::attachment_references_lenient(&old);
        ids.extend(
            butler_canon::store::attachment_references_lenient(&description)
                .into_iter()
                .filter(|id| !retained.contains(id)),
        );
        let mut seen = std::collections::BTreeSet::new();
        ids.retain(|id| seen.insert(id.clone()));
        if ids.is_empty() {
            continue;
        }
        for id in &ids {
            description=app.append_canon_session_files(session.into(),description,vec![id.clone()]).await.map_err(|error| {
                if matches!(&error,GatewayApplicationError::Public {code,..} if code=="invalid_attachment_owner") {
                    public(400,"attachment_not_found",&format!("{id} is not a file of this conversation. Use ids from this turn's attachments."))
                } else { error }
            })?;
        }
        change["description"] = json!(description);
        super::super::canon::files::validate_write(
            app,
            &AppCanonRequest {
                delegate: None,
                resource: AppCanonResource::CreateEpic,
                id: String::new(),
                input: Some(json!({"description":description})),
            },
        )
        .await?;
    }
    Ok(())
}
pub(super) async fn canon_read(
    app: &AppApplication,
    input: Value,
) -> Result<Value, GatewayApplicationError> {
    let args = &input["arguments"];
    if args["view"] == "spec" {
        let id = field(args, "id")?;
        let value = app
            .dependencies
            .canon
            .proposal("spec".into(), json!({"id":id}))
            .await?;
        let project = field(&value, "scope_ref")?;
        super::super::canon::execute(
            app,
            AppCanonRequest {
                delegate: None,
                resource: AppCanonResource::Canon,
                id: project,
                input: None,
            },
        )
        .await?;
        return Ok(json!({"ok":true,"untrusted_content":value}));
    }
    let resource = match args["view"].as_str() {
        Some("epic") => AppCanonResource::Epic,
        Some("plan") => AppCanonResource::Plan,
        Some("tags") => AppCanonResource::Tags,
        Some("canon") => AppCanonResource::Canon,
        _ => {
            return Err(public(
                400,
                "invalid_arguments",
                "view must be canon, epic, plan or tags",
            ));
        }
    };
    let session = field(&input, "session_id")?;
    let id = if matches!(resource, AppCanonResource::Canon | AppCanonResource::Tags) {
        target_project(app, &session, args["project_id"].as_str())
            .await?
            .ok_or_else(|| public(400, "no_project", "Choose a project."))?
    } else {
        field(args, "id")?
    };
    let value = shared_view(app, resource, &id).await?;
    let mut result = json!({"ok":true,"untrusted_content":value});
    if args["bind"] == true {
        if resource != AppCanonResource::Epic {
            return Err(public(400, "invalid_arguments", "bind requires view epic"));
        }
        let owner = app.runtime_hint(&session).await?;
        result["binding"] = app
            .dependencies
            .canon
            .proposal("bind".into(), json!({"id":id,"session_id":owner}))
            .await?;
    }
    Ok(result)
}

async fn shared_view(
    app: &AppApplication,
    resource: AppCanonResource,
    id: &str,
) -> Result<Value, GatewayApplicationError> {
    let mut value = super::super::canon::execute(
        app,
        AppCanonRequest {
            delegate: None,
            resource,
            id: id.into(),
            input: None,
        },
    )
    .await?;
    if resource == AppCanonResource::Canon {
        value["specs"] = app
            .dependencies
            .canon
            .proposal("specs".into(), json!({"id":id}))
            .await?;
    }
    Ok(value)
}

pub(in crate::gateway::application) async fn language(
    app: &AppApplication,
) -> Result<&'static str, GatewayApplicationError> {
    let facts = app.dependencies.settings_facts.snapshot()?;
    app.storage
        .read(move |db| {
            super::super::settings::ui_language(db, &facts).map(|language| match language {
                crate::gateway::ui_language::UiLanguage::Korean => "ko",
                crate::gateway::ui_language::UiLanguage::English => "en",
            })
        })
        .await
        .map_err(app_error)
}
