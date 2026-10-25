//! Authenticated editable-document HTTP adapter.
use super::*;
use crate::gateway::AppDocumentCommand as C;
use serde_json::{Value, json};
pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let args = query(request.uri());
    let parts = path
        .trim_start_matches("/documents")
        .split('/')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    if let (&Method::POST, [id, "blocks", index]) = (&method, parts.as_slice()) {
        let index = index.parse::<usize>().map_err(|_| {
            HttpError::public(400, "invalid_document_request", "Invalid block index.")
        })?;
        let value = state
            .application
            .library(crate::gateway::AppLibraryCommand::SaveDocumentBlock {
                document_id: (*id).into(),
                index,
            })
            .await?;
        return json(
            StatusCode::OK,
            json!({"protocol_version":APP_PROTOCOL_VERSION,"data":value}),
        );
    }
    let command = match (&method, parts.as_slice()) {
        (&Method::POST, []) => C::Create(input(request).await?),
        (&Method::GET, [id]) => C::Get((*id).into()),
        (&Method::PUT, [id]) => C::Save((*id).into(), input(request).await?),
        (&Method::GET, [id, "revisions"]) => C::Revisions((*id).into()),
        (&Method::GET, [id, "revisions", rev]) => C::Revision((*id).into(), revision(rev)?),
        (&Method::POST, [id, "restore"]) => C::Restore((*id).into(), input(request).await?),
        (&Method::POST, [id, "seen"]) => C::Seen((*id).into(), input(request).await?),
        (&Method::GET, [id, "diff"]) => C::Diff(
            (*id).into(),
            revision(args.get("from").map_or("", String::as_str))?,
        ),
        _ => {
            return Err(HttpError::public(
                405,
                "method_not_allowed",
                "Method not allowed.",
            ));
        }
    };
    let value = state
        .application
        .library(crate::gateway::AppLibraryCommand::Document(command))
        .await?;
    if value["code"] == "revision_conflict" {
        return json(
            StatusCode::CONFLICT,
            json!({"code":"revision_conflict","rev":value["rev"],"error":{"code":"revision_conflict","message":"Read the current revision and retry.","rev":value["rev"]}}),
        );
    }
    json(
        StatusCode::OK,
        json!({"protocol_version":APP_PROTOCOL_VERSION,"data":value}),
    )
}
async fn input(request: Request<Body>) -> Result<Value, HttpError> {
    // JSON escaping can expand a body up to six times; storage checks decoded bytes.
    let bytes = read_body_with_limit(request.into_body(), 6 * 256 * 1024 + 4096).await?;
    serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())
}
fn revision(text: &str) -> Result<i64, HttpError> {
    text.parse::<i64>().ok().filter(|n| *n > 0).ok_or_else(|| {
        HttpError::public(
            400,
            "invalid_document_request",
            "Revision must be a positive integer.",
        )
    })
}
