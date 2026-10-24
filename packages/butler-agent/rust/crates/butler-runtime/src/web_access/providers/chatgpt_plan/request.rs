//! One refresh retry; every other primary error belongs to the existing fallback.
use super::memo;
use crate::web_access::service::{WebAccess, WebAccessError};
use butler_models::models::ProviderAuth;
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use url::Url;
pub(super) async fn request(
    access: &WebAccess,
    endpoint: Url,
    body: &Value,
    authorization: &str,
    key: &(String, String),
    cancellation: &CancellationToken,
) -> Result<Vec<u8>, WebAccessError> {
    let mut authorization = zeroize::Zeroizing::new(authorization.to_owned());
    for attempt in 0..2 {
        let request = access
            .client()
            .post(endpoint.clone())
            .purpose(butler_log::http::Purpose::provider("openai", "web_search"))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .header(reqwest::header::AUTHORIZATION, authorization.as_str())
            .json(body);
        let (status, bytes) =
            super::super::http::response_bytes(access, request, cancellation).await?;
        if status == 401 && attempt == 0 {
            let config = access.configuration().ok_or_else(memo::failed)?;
            let private = access.private_environment()?;
            let auth = config
                .resolve_chatgpt_auth_for_web_search(&private, Some(&authorization))
                .await
                .map_err(|_| memo::failed())?;
            let ProviderAuth::ChatGptPlan {
                authorization: next,
                ..
            } = auth
            else {
                return Err(memo::failed());
            };
            authorization = next;
            continue;
        }
        let body = serde_json::from_slice::<Value>(&bytes).unwrap_or_default();
        if matches!(
            (status, body.pointer("/error/code").and_then(Value::as_str)),
            (400, Some("subscription_sharing_unsupported_capability"))
                | (403, Some("subscription_sharing_route_not_supported"))
        ) {
            memo::unsupported(access.data_root(), key);
        }
        return if (200..300).contains(&status) {
            Ok(bytes)
        } else {
            Err(memo::failed())
        };
    }
    Err(memo::failed())
}
