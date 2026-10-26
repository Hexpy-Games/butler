//! Authenticated pattern reads and explicit revision-checked actions.
use super::*;
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Delete {
    expected_revision: u64,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Decision {
    pattern_id: String,
    decision: String,
    expected_revision: u64,
}
pub(super) async fn command(
    request: axum::http::Request<Body>,
    path: &str,
) -> Result<AppMemoryCommand, HttpError> {
    match (request.method(), path) {
        (&Method::GET, "/memory/patterns") => Ok(AppMemoryCommand::Patterns),
        (&Method::GET, "/memory/pattern-proposals") => Ok(AppMemoryCommand::PatternProposals),
        (&Method::DELETE, path) if path.starts_with("/memory/patterns/") => {
            let id = id(path, "/memory/patterns/")?;
            let bytes = read_body_with_limit(request.into_body(), 4096).await?;
            let input: Delete = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
            Ok(AppMemoryCommand::DeletePattern {
                id,
                expected_revision: input.expected_revision,
            })
        }
        (&Method::POST, path) if path.starts_with("/memory/pattern-proposals/") => {
            let bundle_id = id(path, "/memory/pattern-proposals/")?;
            let bytes = read_body_with_limit(request.into_body(), 4096).await?;
            let input: Decision = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
            if !matches!(input.decision.as_str(), "accepted" | "declined")
                || input.pattern_id.is_empty()
            {
                return Err(invalid());
            }
            Ok(AppMemoryCommand::DecidePattern {
                bundle_id,
                pattern_id: input.pattern_id,
                decision: input.decision,
                expected_revision: input.expected_revision,
            })
        }
        _ => Err(HttpError::public(404, "not_found", "Route not found.")),
    }
}
fn id(path: &str, prefix: &str) -> Result<String, HttpError> {
    path.strip_prefix(prefix)
        .filter(|id| !id.is_empty() && !id.contains('/'))
        .map(str::to_owned)
        .ok_or_else(invalid)
}
