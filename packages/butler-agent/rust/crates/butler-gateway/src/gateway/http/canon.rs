//! Local-only canon routes; normal gateway auth protects this handler.
use super::*;
use crate::gateway::AppCanonRequest;

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    let parts: Vec<_> = uri.path().trim_start_matches('/').split('/').collect();
    if matches!(parts.as_slice(), ["sessions", _, "canon", "queue", ..]) {
        return super::canon_queue::route(state, request, &parts).await;
    }
    if matches!(
        parts.as_slice(),
        ["canon", "proposals", _] | ["sessions", _, "canon", _]
    ) {
        if delegate(request.headers())?.is_some() {
            return Err(HttpError::public(
                403,
                "permission",
                "허용되지 않은 작업입니다.",
            ));
        }
        return super::canon_proposals::route(state, request, &parts).await;
    }
    if request.method() == Method::POST
        && let ["projects", id, "canon", "files"] = parts.as_slice()
    {
        return upload(state, request, id).await;
    }
    resources(state, request, &parts).await
}

async fn resources(
    state: Arc<HttpState>,
    request: Request<Body>,
    parts: &[&str],
) -> Result<Response, HttpError> {
    let delegate = delegate(request.headers())?;
    use crate::gateway::AppCanonResource::{
        Activity, CheckCriterion, CreateEpic, CreatePlan, CreateTag, Grants, List,
    };
    let (resource, id) = resource(request.method(), parts)?;
    let mut id = subsessions::decode_component(id)?;
    let query = query(request.uri())?;
    if resource == List {
        id = query["project"].as_str().unwrap_or_default().into();
    }
    let mut input = if matches!(resource, List | Activity | Grants) {
        Some(query)
    } else if request.method() == Method::GET {
        None
    } else if request.method() == Method::DELETE
        && resource != crate::gateway::AppCanonResource::DeleteEpic
    {
        Some(serde_json::json!({}))
    } else {
        let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
        Some(serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?)
    };
    if resource == CheckCriterion
        && let ["canon", "specs", _, "criteria", criterion] = parts
    {
        let body = input
            .as_mut()
            .and_then(serde_json::Value::as_object_mut)
            .ok_or_else(HttpError::invalid_json)?;
        body.insert(
            "criterion_id".into(),
            serde_json::json!(subsessions::decode_component(criterion)?),
        );
    }
    let data = state
        .application
        .canon(AppCanonRequest {
            resource,
            id,
            input,
            delegate,
        })
        .await?;
    let status = if matches!(resource, CreatePlan | CreateEpic | CreateTag) {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    json(
        status,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}

pub(super) fn delegate(
    headers: &hyper::HeaderMap,
) -> Result<Option<crate::gateway::AppCanonDelegate>, HttpError> {
    let title = headers.get("X-Butler-Delegate-Client");
    let name = headers.get("X-Butler-Delegate-Client-Name");
    if title.is_none() && name.is_none() {
        return Ok(None);
    }
    let clean = |v: Option<&hyper::header::HeaderValue>| {
        v.and_then(|v| std::str::from_utf8(v.as_bytes()).ok())
            .map(butler_canon::store::sanitize_mcp_client)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| HttpError::public(400, "invalid_delegate", "Client identity required."))
    };
    Ok(Some(crate::gateway::AppCanonDelegate {
        name: clean(name)?,
        title: clean(title)?,
    }))
}
fn query(uri: &Uri) -> Result<serde_json::Value, HttpError> {
    let mut input = serde_json::json!({});
    for (key, value) in url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes()) {
        input[key.as_ref()] = match key.as_ref() {
            "before" => serde_json::json!(
                value
                    .parse::<i64>()
                    .map_err(|_| HttpError::invalid_json())?
            ),
            "include_done" => serde_json::json!(
                value
                    .parse::<bool>()
                    .map_err(|_| HttpError::invalid_json())?
            ),
            _ => serde_json::json!(value),
        };
    }
    Ok(input)
}

fn resource<'a>(
    method: &Method,
    parts: &[&'a str],
) -> Result<(crate::gateway::AppCanonResource, &'a str), HttpError> {
    use crate::gateway::AppCanonResource::{
        Activity, AllowGrant, BacklogOrder, Canon, CheckCriterion, Comment, CreateEpic, CreatePlan,
        CreateTag, DeleteEpic, DeleteTag, DenyGrant, EditEpic, EditPlan, EditTag, Epic,
        EpicProgress, Grants, List, Plan, PlanOrder, ProposeSpec, RevokeGrant, Spec, Tags,
    };
    Ok(match (method, parts) {
        (&Method::GET, ["canon", "list"]) => (List, ""),
        (&Method::GET, ["canon", "mcp-grants"]) => (Grants, ""),
        (&Method::POST, ["canon", "mcp-grants", id, "allow"]) => (AllowGrant, *id),
        (&Method::POST, ["canon", "mcp-grants", id, "deny"]) => (DenyGrant, *id),
        (&Method::POST, ["canon", "mcp-grants", id, "revoke"]) => (RevokeGrant, *id),
        (&Method::GET, ["canon", "specs", id]) => (Spec, *id),
        (&Method::POST, ["canon", "specs", id, "criteria", _]) => (CheckCriterion, *id),
        (&Method::POST, ["canon", "specs", id, "proposals"]) => (ProposeSpec, *id),
        (&Method::POST, ["canon", "epics", id, "comments"]) => (Comment, *id),
        (&Method::GET, ["canon", "epics", id, "activity"]) => (Activity, *id),
        (&Method::GET, ["projects", id, "canon", "tags"]) => (Tags, *id),
        (&Method::POST, ["projects", id, "canon", "tags"]) => (CreateTag, *id),
        (&Method::PATCH, ["canon", "tags", id]) => (EditTag, *id),
        (&Method::DELETE, ["canon", "tags", id]) => (DeleteTag, *id),
        (&Method::GET, ["projects", id, "canon"]) => (Canon, *id),
        (&Method::GET, ["canon", "plans", id]) => (Plan, *id),
        (&Method::GET, ["canon", "epics", id]) => (Epic, *id),
        (&Method::GET, ["canon", "epics", id, "progress"]) => (EpicProgress, *id),
        (&Method::POST, ["projects", id, "canon", "plans"]) => (CreatePlan, *id),
        (&Method::PATCH, ["canon", "plans", id]) => (EditPlan, *id),
        (&Method::POST, ["canon", "plans", id, "order"]) => (PlanOrder, *id),
        (&Method::POST, ["projects", id, "canon", "backlog", "order"]) => (BacklogOrder, *id),
        (&Method::POST, ["projects", id, "canon", "epics"]) => (CreateEpic, *id),
        (&Method::PATCH, ["canon", "epics", id]) => (EditEpic, *id),
        (&Method::DELETE, ["canon", "epics", id]) => (DeleteEpic, *id),
        _ => {
            return Err(HttpError::public(
                405,
                "method_not_allowed",
                "Method not allowed.",
            ));
        }
    })
}

async fn upload(
    state: Arc<HttpState>,
    request: Request<Body>,
    id: &str,
) -> Result<Response, HttpError> {
    if delegate(request.headers())?.is_some() {
        return Err(HttpError::public(
            403,
            "permission",
            "허용되지 않은 작업입니다.",
        ));
    }
    let id = subsessions::decode_component(id)?;
    let _upload = state
        .uploads
        .acquire()
        .await
        .map_err(|_| HttpError::Internal)?;
    let input = super::message_files::parse_upload(request).await?;
    let file = state.application.upload_canon_file(id, input).await?;
    json(
        StatusCode::CREATED,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: serde_json::json!({"file":file}),
        },
    )
}
