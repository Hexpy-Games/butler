use super::*;

#[tokio::test]
async fn local_dev_preflight_and_actual_responses_preserve_auth() {
    let application = Arc::new(TestApplication::default());
    *application.briefing.lock().unwrap() = Some(json!({
        "moment":"Onboarding", "title":"Welcome", "suggestions":[],
        "source":{"scope":"onboarding","content_origin":"heuristic_fallback"},
        "raw_text_included":false
    }));
    let server = start(
        application,
        LocalAuthConfig::required(Some("secret".into())),
    )
    .await;
    for path in ["/model-catalog", "/navigation", "/settings"] {
        let response = request(
            server.local_addr(),
            &format!("OPTIONS {path} HTTP/1.1\r\nhost: localhost\r\norigin: http://127.0.0.1:5173\r\naccess-control-request-method: GET\r\naccess-control-request-headers: authorization,content-type\r\nconnection: close\r\n\r\n"),
        ).await.to_ascii_lowercase();
        assert!(response.starts_with("http/1.1 204"));
        assert!(response.contains("access-control-allow-origin: http://127.0.0.1:5173"));
        assert!(response.contains("access-control-allow-headers: authorization, content-type"));
    }
    let unauthorized = request(server.local_addr(), "GET /new-chat-briefing HTTP/1.1\r\nhost: localhost\r\norigin: http://127.0.0.1:5173\r\nconnection: close\r\n\r\n").await.to_ascii_lowercase();
    assert!(unauthorized.starts_with("http/1.1 401"));
    assert!(unauthorized.contains("access-control-allow-origin: http://127.0.0.1:5173"));
    let authorized = request(server.local_addr(), "GET /new-chat-briefing HTTP/1.1\r\nhost: localhost\r\norigin: http://127.0.0.1:5173\r\nauthorization: Bearer secret\r\nconnection: close\r\n\r\n").await.to_ascii_lowercase();
    assert!(authorized.starts_with("http/1.1 200"));
    assert!(authorized.contains("access-control-allow-origin: http://127.0.0.1:5173"));
    let foreign = request(server.local_addr(), "OPTIONS /model-catalog HTTP/1.1\r\nhost: localhost\r\norigin: https://remote.example\r\naccess-control-request-method: GET\r\nconnection: close\r\n\r\n").await.to_ascii_lowercase();
    assert!(!foreign.contains("access-control-allow-origin"));
    server.close().await.unwrap();
}
