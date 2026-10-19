use super::*;

// test-category: security
#[tokio::test]
async fn occupied_content_port_uses_bound_port_in_ui_frames() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let primary = listener.local_addr().unwrap();
    let foreign = tokio::net::TcpListener::bind((primary.ip(), primary.port() + 1))
        .await
        .unwrap();
    let root = std::env::temp_dir().join(format!("gateway-content-ui-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("index.html"), "<!doctype html><title>UI</title>").unwrap();
    let server = serve_gateway(
        listener,
        Arc::new(TestApplication::default()),
        GatewayConfig {
            local_auth: LocalAuthConfig::required(Some("secret".into())),
            static_ui_root: Some(root.clone()),
            ..GatewayConfig::default()
        },
    )
    .await
    .unwrap();
    let bound = server.content_addr();
    assert_eq!(bound.ip(), primary.ip());
    assert_ne!(bound.port(), primary.port());
    assert_ne!(bound.port(), foreign.local_addr().unwrap().port());
    let reply = request(server.local_addr(), "GET / HTTP/1.1\r\nhost: localhost\r\nauthorization: Bearer secret\r\nconnection: close\r\n\r\n").await;
    assert!(reply.starts_with("HTTP/1.1 200 OK"), "{reply}");
    let csp = reply
        .lines()
        .find(|line| line.starts_with("content-security-policy:"))
        .unwrap();
    let frames = csp.split("frame-src ").nth(1).unwrap();
    assert!(frames.contains(&format!("http://{bound}")), "{csp}");
    assert!(
        frames.contains(&format!("http://localhost:{}", bound.port())),
        "{csp}"
    );
    assert!(
        !frames.contains(&format!("http://127.0.0.1:{}", primary.port() + 1)),
        "{csp}"
    );
    server.close().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
