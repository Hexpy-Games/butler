use super::*;

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;

use super::artifact_session::{open_app, start_real};

static NEXT_DB: AtomicU64 = AtomicU64::new(1);

#[tokio::test]
async fn session_queue_route_reads_publicly_queued_message_after_reopen() {
    let path = std::env::temp_dir().join(format!(
        "butler-session-queue-route-{}-{}.sqlite",
        std::process::id(),
        NEXT_DB.fetch_add(1, Ordering::Relaxed)
    ));
    let application = Arc::new(open_app(&path).await);
    let server = start_real(application.clone()).await;

    let first = authorized_json(
        server.local_addr(),
        r#"{"chat_id":"general","text":"first","client_message_id":"queue-first"}"#,
    )
    .await;
    assert!(first.starts_with("HTTP/1.1 202 Accepted"), "{first}");
    let second = authorized_json(
        server.local_addr(),
        r#"{"chat_id":"general","text":"second","client_message_id":"queue-second"}"#,
    )
    .await;
    assert!(second.starts_with("HTTP/1.1 202 Accepted"), "{second}");
    assert!(second.contains("\"queued\":{"));

    let first_view = queue_request(server.local_addr(), "sessionId").await;
    assert!(first_view.starts_with("HTTP/1.1 200 OK"));
    assert!(first_view.contains("\"session_id\":\"general\""));
    assert!(first_view.contains("\"text\":\"second\""));
    assert!(first_view.contains("\"state\":\"queued\""));
    assert!(!first_view.contains("\"text\":\"first\""));
    assert!(
        default_queue_request(server.local_addr())
            .await
            .contains("\"session_id\":\"general\"")
    );

    server.close().await.unwrap();
    application.close().await.unwrap();

    let reopened = Arc::new(open_app(&path).await);
    let server = start_real(reopened.clone()).await;
    let second_view = queue_request(server.local_addr(), "session_id").await;
    assert!(second_view.starts_with("HTTP/1.1 200 OK"));
    assert!(second_view.contains("\"session_id\":\"general\""));
    assert!(second_view.contains("\"text\":\"second\""));
    assert!(second_view.contains("\"state\":\"queued\""));
    server.close().await.unwrap();
    reopened.close().await.unwrap();
    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn public_session_queue_create_patch_delete_emits_each_mutation() {
    let path = std::env::temp_dir().join(format!(
        "butler-session-queue-mutations-{}-{}.sqlite",
        std::process::id(),
        NEXT_DB.fetch_add(1, Ordering::Relaxed)
    ));
    let application = Arc::new(open_app(&path).await);
    let server = start_real(application.clone()).await;

    let created = queue_mutation(
        server.local_addr(),
        "POST",
        "/session-queue",
        r#"{"chat_id":"general","text":"before","client_message_id":"mutation-sequence"}"#,
    )
    .await;
    assert!(created.starts_with("HTTP/1.1 202 Accepted"), "{created}");
    let created_json = response_json(&created);
    let queued_id = created_json["data"]["queued_messages"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(created_json["data"]["queued_messages"][0]["text"], "before");

    let patched = queue_mutation(
        server.local_addr(),
        "PATCH",
        &format!("/session-queue/{queued_id}"),
        r#"{"text":"after"}"#,
    )
    .await;
    assert!(patched.starts_with("HTTP/1.1 200 OK"), "{patched}");
    let patched_json = response_json(&patched);
    assert_eq!(patched_json["data"]["queued_messages"][0]["text"], "after");

    let deleted = queue_mutation(
        server.local_addr(),
        "DELETE",
        &format!("/session-queue/{queued_id}"),
        "",
    )
    .await;
    assert!(deleted.starts_with("HTTP/1.1 200 OK"), "{deleted}");
    assert!(deleted.contains("\"queued_messages\":[]"));

    let events = request(
        server.local_addr(),
        "GET /events?cursor=0 HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n",
    )
    .await;
    assert_eq!(events.matches("\"action\":\"created\"").count(), 1);
    assert_eq!(events.matches("\"action\":\"updated\"").count(), 1);
    assert_eq!(events.matches("\"action\":\"deleted\"").count(), 1);

    server.close().await.unwrap();
    application.close().await.unwrap();
    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn public_session_queue_replay_keeps_identity_and_rejects_conflict() {
    let path = std::env::temp_dir().join(format!(
        "butler-session-queue-replay-{}-{}.sqlite",
        std::process::id(),
        NEXT_DB.fetch_add(1, Ordering::Relaxed)
    ));
    let application = Arc::new(open_app(&path).await);
    let server = start_real(application.clone()).await;
    let body = r#"{"chat_id":"general","text":"same","client_message_id":"replay-identity"}"#;

    let first = queue_mutation(server.local_addr(), "POST", "/session-queue", body).await;
    let first_id = response_json(&first)["data"]["queued_messages"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let replay = queue_mutation(server.local_addr(), "POST", "/session-queue", body).await;
    assert!(replay.starts_with("HTTP/1.1 202 Accepted"));
    assert_eq!(
        response_json(&replay)["data"]["queued_messages"][0]["id"],
        first_id
    );

    let conflict = queue_mutation(
        server.local_addr(),
        "POST",
        "/session-queue",
        r#"{"chat_id":"general","text":"different","client_message_id":"replay-identity"}"#,
    )
    .await;
    assert!(conflict.starts_with("HTTP/1.1 409 Conflict"));
    assert!(conflict.contains("\"code\":\"queued_message_identity_conflict\""));

    server.close().await.unwrap();
    application.close().await.unwrap();
    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn public_session_queue_authority_entries_cannot_be_patched_or_deleted() {
    let path = std::env::temp_dir().join(format!(
        "butler-session-queue-authority-{}-{}.sqlite",
        std::process::id(),
        NEXT_DB.fetch_add(1, Ordering::Relaxed)
    ));
    let application = Arc::new(open_app(&path).await);
    crate::gateway::application::seed_test_authority_queue(&application, "queued-authority")
        .await
        .unwrap();
    let server = start_real(application.clone()).await;

    let patched = queue_mutation(
        server.local_addr(),
        "PATCH",
        "/session-queue/queued-authority",
        r#"{"text":"edited"}"#,
    )
    .await;
    assert!(patched.starts_with("HTTP/1.1 409 Conflict"));
    assert!(patched.contains("\"code\":\"authority_queue_immutable\""));

    let deleted = queue_mutation(
        server.local_addr(),
        "DELETE",
        "/session-queue/queued-authority",
        "",
    )
    .await;
    assert!(deleted.starts_with("HTTP/1.1 409 Conflict"));
    assert!(deleted.contains("\"code\":\"authority_queue_immutable\""));

    server.close().await.unwrap();
    application.close().await.unwrap();
    let _ = std::fs::remove_file(path);
}

async fn queue_request(address: std::net::SocketAddr, parameter: &str) -> String {
    request(
        address,
        &format!(
            "GET /session-queue?{parameter}=general HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n"
        ),
    )
    .await
}

async fn default_queue_request(address: std::net::SocketAddr) -> String {
    request(
        address,
        "GET /session-queue HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n",
    )
    .await
}

async fn queue_mutation(
    address: std::net::SocketAddr,
    method: &str,
    path: &str,
    body: &str,
) -> String {
    request(
        address,
        &format!(
            "{method} {path} HTTP/1.1\r\nhost: localhost\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        ),
    )
    .await
}

fn response_json(response: &str) -> Value {
    serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap()
}
