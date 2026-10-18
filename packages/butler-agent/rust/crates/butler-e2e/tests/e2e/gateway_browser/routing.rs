//! API prefixes must retain their handler's errors before the UI fallback.
use super::*;

#[tokio::test]
async fn api_families_keep_errors_and_method_fallbacks() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("GW-ROUTING")?.start().await?;
    for path in [
        "/__o/",
        "/__o/unknown/nested",
        "/internal/browser-unknown",
        "/previews/unknown/nested",
        "/outputs/unknown/nested",
        "/authority-permissions-unknown",
        "/authority-requests/unknown/nested",
        "/security/unknown/nested",
        "/hooks/unknown/nested",
        "/logs/unknown/nested",
        "/model-catalog/unknown/nested",
        "/memory/unknown/nested",
        "/personalization/unknown/nested",
        "/space/unknown/nested",
        "/projects/unknown/nested",
        "/sessions/unknown/nested",
        "/automations/unknown/nested",
        "/mcp-servers/unknown/nested",
        "/turns/unknown/retry-unknown",
        "/turns/unknown/operations/unknown/nested",
        "/setup/unknown/nested",
        "/credentials/unknown/nested",
        "/wallpapers/unknown/nested",
        "/steward-relations/unknown/nested",
    ] {
        let response = html(&s.gw, path).await?;
        assert_ne!(response.status().as_u16(), 200, "{path}");
        let text = response.text().await?;
        assert!(!text.contains("<!doctype html>"), "{path}: {text}");
    }
    for path in ["/library/unknown/nested", "/browser-history/unknown/nested"] {
        assert_eq!(html(&s.gw, path).await?.status().as_u16(), 405, "{path}");
    }
    for path in [
        "/unknown-page",
        "/turns/unknown/cancel",
        "/session-queue/unknown",
        "/__o",
    ] {
        assert_eq!(html(&s.gw, path).await?.status().as_u16(), 200, "{path}");
        assert_eq!(
            s.gw.send(Method::DELETE, path, None).await?.status,
            404,
            "{path}"
        );
    }
    s.finish().await
}

async fn html(gw: &Gateway, path: &str) -> Result<reqwest::Response, HarnessError> {
    Ok(gw
        .http()
        .get(url(gw, path))
        .bearer_auth(&gw.token)
        .header("accept", "text/html")
        .send()
        .await?)
}
