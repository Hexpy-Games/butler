//! Admission runs before scope reads and mutations for every delegated request.
use super::*;
use butler_canon::store::sanitize_mcp_client as sanitize;

pub(super) async fn prepare(
    app: &AppApplication,
    request: &mut AppCanonRequest,
) -> Result<(), GatewayApplicationError> {
    use AppCanonResource::*;
    if let Some(delegate) = &mut request.delegate {
        delegate.name = sanitize(&delegate.name);
        delegate.title = sanitize(&delegate.title);
        if delegate.name.is_empty() || delegate.title.is_empty() {
            return Err(public(400, "invalid_delegate", "Client identity required."));
        }
        let capability = match request.resource {
            Canon | List | Plan | Epic | Spec | Activity => "canon.read",
            EditEpic if status_only(request.input.as_ref()) => "canon.epic.status",
            Comment => "canon.epic.comment",
            CreateEpic => "canon.epic.create",
            ProposeSpec => "canon.spec.propose",
            _ => return Err(public(403, "permission", "허용되지 않은 작업입니다.")),
        };
        let result = app
            .dependencies
            .canon
            .admit(delegate.clone(), capability.into())
            .await?;
        if result["allowed"] != true {
            let code = result["code"].as_str().unwrap_or("permission");
            return Err(public(
                403,
                code,
                if code == "trust_pending" {
                    "버틀러 앱에서 허용해 주세요."
                } else {
                    "허용되지 않은 작업입니다."
                },
            ));
        }
    }
    if (request.resource == List || (request.resource == CreateEpic && request.delegate.is_some()))
        && !request.id.is_empty()
    {
        let requested = request.id.clone();
        let ids=app.storage.read(move |db| {
            use rusqlite::OptionalExtension;
            if let Some(id)=db.query_row("SELECT id FROM projects WHERE id=?1 AND archived=0",[&requested],|r|r.get::<_,String>(0)).optional().map_err(AppStorageError::sqlite)? {return Ok(vec![id]);}
            db.prepare("SELECT id FROM projects WHERE display_name=?1 AND archived=0 ORDER BY id LIMIT 2").map_err(AppStorageError::sqlite)?
                .query_map([requested],|r|r.get::<_,String>(0)).map_err(AppStorageError::sqlite)?.collect::<rusqlite::Result<Vec<_>>>().map_err(AppStorageError::sqlite)
        }).await.map_err(app_error)?;
        request.id = match ids.as_slice() {
            [id] => id.clone(),
            [] => return Err(public(404, "project_not_found", "Project not found.")),
            _ => {
                return Err(public(
                    400,
                    "invalid_arguments",
                    "프로젝트 ID를 지정해 주세요.",
                ));
            }
        };
    }
    Ok(())
}
fn status_only(input: Option<&Value>) -> bool {
    input.and_then(Value::as_object).is_some_and(|o| {
        o.contains_key("status")
            && o.keys()
                .all(|k| matches!(k.as_str(), "status" | "expected_revision"))
    })
}
fn public(status: u16, code: &str, message: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status,
        code: code.into(),
        message: message.into(),
        source: None,
    }
}
