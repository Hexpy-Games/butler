//! Explicit saved-item commands over the existing authenticated App routes.
pub(super) mod history;
mod input;
use super::subsessions::decode_component;
use super::*;
use crate::gateway::AppLibraryCommand as C;
use serde_json::{Value, json};
pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let args = query(request.uri());
    let parts = components(&path)?;
    let parts = parts.iter().map(String::as_str).collect::<Vec<_>>();
    let command = command_from_request(&method, &parts, &args, request).await?;
    let value = state.application.library(command).await?;
    json(
        StatusCode::OK,
        json!({"protocol_version":APP_PROTOCOL_VERSION,"data":value}),
    )
}

async fn command_from_request(
    method: &Method,
    parts: &[&str],
    args: &std::collections::HashMap<String, String>,
    request: Request<Body>,
) -> Result<C, HttpError> {
    Ok(match (method, parts) {
        (&Method::GET, []) => match args.get("url") {
            Some(url) => C::Bookmark { url: url.clone() },
            None => C::Page(input::page(args)?),
        },
        (&Method::POST, []) => C::Save(input::item(body(request, 10 * 1024 * 1024).await?)?),
        (&Method::POST, ["blocks"]) => {
            let value = body(request, LIMIT).await?;
            C::SaveBlock {
                message_id: value["message_id"].as_str().unwrap_or_default().to_owned(),
                path: value["path"].as_str().unwrap_or_default().to_owned(),
            }
        }
        (&Method::POST, ["documents"]) => {
            let value = body(request, LIMIT).await?;
            C::Promote {
                file_id: value["file_id"].as_str().unwrap_or_default().to_owned(),
            }
        }
        (&Method::GET, ["search"]) => C::Search(input::search(args)?),
        (&Method::POST, ["organize"]) => {
            C::Change(input::change(&body(request, LIMIT).await?, true)?)
        }
        (&Method::PATCH, ["items"]) => {
            C::Change(input::change(&body(request, LIMIT).await?, false)?)
        }
        (&Method::GET, ["groups"]) => C::Groups {
            kind: input::grouped_kind(args.get("kind"))?,
        },
        (&Method::POST, ["groups"]) => {
            let value = body(request, LIMIT).await?;
            C::CreateGroup {
                kind: input::grouped_kind(value["kind"].as_str().map(str::to_owned).as_ref())?,
                name: input::group_name(&value["name"])?,
            }
        }
        (&Method::PATCH, ["groups", id]) => group_update(id, &body(request, LIMIT).await?)?,
        (&Method::DELETE, ["groups", id]) => C::DeleteGroup {
            id: (*id).to_owned(),
        },
        (&Method::GET, ["tags"]) => C::Tags,
        (&Method::PATCH, ["tags"]) => {
            let value = body(request, LIMIT).await?;
            C::RenameTag {
                from: input::tag(&value["from"])?,
                to: input::tag(&value["to"])?,
            }
        }
        (&Method::DELETE, ["tags", name]) => C::DeleteTag {
            name: (*name).to_owned(),
        },
        (&Method::GET, ["facets"]) => C::Facets {
            kind: input::kinds(args)?,
            group: args.get("group").cloned(),
        },
        (&Method::GET, [id, "snapshot"]) => C::Snapshot {
            id: (*id).to_owned(),
        },
        (&Method::GET, [id]) => C::Item {
            id: (*id).to_owned(),
        },
        (&Method::DELETE, [id]) => C::Delete {
            id: (*id).to_owned(),
        },
        _ => {
            return Err(HttpError::public(
                405,
                "method_not_allowed",
                "Method not allowed.",
            ));
        }
    })
}
/// Body bytes of every organize command.
const LIMIT: usize = 1024 * 1024;
async fn body(request: Request<Body>, limit: usize) -> Result<Value, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), limit).await?;
    serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())
}

fn components(path: &str) -> Result<Vec<String>, HttpError> {
    path.trim_start_matches("/library")
        .split('/')
        .filter(|part| !part.is_empty())
        .map(|part| {
            decode_component(part)
                .map_err(|_| HttpError::public(400, "invalid_library_request", "Invalid path."))
        })
        .collect()
}
fn group_update(id: &str, value: &Value) -> Result<C, HttpError> {
    Ok(C::UpdateGroup {
        id: id.to_owned(),
        name: (!value["name"].is_null())
            .then(|| input::group_name(&value["name"]))
            .transpose()?,
        position: input::position(&value["position"])?,
    })
}
