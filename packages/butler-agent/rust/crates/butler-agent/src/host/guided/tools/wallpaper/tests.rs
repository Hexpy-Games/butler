use std::sync::Arc;

use parking_lot::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::*;
use butler_gateway::gateway::LocalAuthConfig;

/// One request the stub App received.
#[derive(Clone, Debug)]
pub(in crate::host::guided::tools) struct Received {
    pub(in crate::host::guided::tools) line: String,
    /// Lowercased request head.
    pub(in crate::host::guided::tools) head: String,
    pub(in crate::host::guided::tools) body: Value,
}

/// A local App endpoint answering every request with one status and body,
/// recording what it received.
pub(in crate::host::guided::tools) struct StubApp {
    pub(in crate::host::guided::tools) endpoint: Arc<ActiveAppEndpoint>,
    pub(in crate::host::guided::tools) received: Arc<Mutex<Vec<Received>>>,
}

pub(in crate::host::guided::tools) async fn stub_app(status: u16, body: &Value) -> StubApp {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let received = Arc::new(Mutex::new(Vec::new()));
    let log = received.clone();
    let payload = body.to_string();
    tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_request(&mut stream).await;
            log.lock().push(request);
            let reply = format!(
                "HTTP/1.1 {status} Stub\r\ncontent-type: application/json\r\n\
                 content-length: {}\r\nconnection: close\r\n\r\n{payload}",
                payload.len()
            );
            stream.write_all(reply.as_bytes()).await.unwrap();
        }
    });
    let endpoint = Arc::new(ActiveAppEndpoint::new());
    endpoint.publish_for_test(
        format!("http://{address}"),
        LocalAuthConfig::required(Some("secret".into())),
    );
    StubApp { endpoint, received }
}

async fn read_request(stream: &mut TcpStream) -> Received {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        let read = stream.read(&mut chunk).await.unwrap();
        bytes.extend_from_slice(&chunk[..read]);
        let Some(split) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
            continue;
        };
        let head = String::from_utf8(bytes[..split].to_vec())
            .unwrap()
            .to_ascii_lowercase();
        let length = head
            .lines()
            .find_map(|line| line.strip_prefix("content-length:"))
            .map_or(0, |value| value.trim().parse::<usize>().unwrap());
        while bytes.len() < split + 4 + length {
            let read = stream.read(&mut chunk).await.unwrap();
            bytes.extend_from_slice(&chunk[..read]);
        }
        let line = String::from_utf8(bytes[..split].to_vec()).unwrap();
        return Received {
            line: line.lines().next().unwrap().to_owned(),
            head,
            body: serde_json::from_slice(&bytes[split + 4..split + 4 + length])
                .unwrap_or(Value::Null),
        };
    }
}

#[tokio::test]
async fn list_reads_the_overview_for_the_conversation_project() {
    let data = json!({"global": {"source": {"kind": "none"}}, "modules": [], "images": []});
    let app = stub_app(
        200,
        &json!({"protocol_version": "butler.app.v1", "data": data}),
    )
    .await;
    let signal = CancellationToken::new();
    let query = [("project_id", "project 1")];
    let reply = app_json(&app.endpoint, Method::GET, &query, None, &signal).await;
    assert_eq!(
        overview(reply),
        json!({"ok": true, "global": {"source": {"kind": "none"}}, "modules": [], "images": []})
    );
    let received = app.received.lock()[0].clone();
    assert_eq!(
        received.line,
        "GET /internal/wallpaper?project_id=project+1 HTTP/1.1"
    );
    assert!(
        received.head.contains("authorization: bearer secret"),
        "{}",
        received.head
    );

    let arguments = |value: Value| value.as_object().unwrap().clone();
    assert_eq!(
        project(&arguments(json!({})), Some("p1")),
        Some("p1".into())
    );
    assert_eq!(
        project(&arguments(json!({"project_id": " p2 "})), Some("p1")),
        Some("p2".into())
    );
    assert_eq!(project(&arguments(json!({"project_id": ""})), None), None);
}

#[tokio::test]
async fn list_failures_are_model_readable() {
    let error = json!({"error": {"code": "project_not_found", "message": "Project not found."}});
    let app = stub_app(404, &error).await;
    let signal = CancellationToken::new();
    let reply = app_json(&app.endpoint, Method::GET, &[], None, &signal).await;
    assert_eq!(
        overview(reply),
        json!({"ok": false, "error": {"code": "project_not_found", "message": "Project not found."}})
    );
    let offline = ActiveAppEndpoint::new();
    let reply = app_json(&offline, Method::GET, &[], None, &signal).await;
    assert_eq!(
        reply,
        Err(AppCallError {
            code: "app_gateway_unavailable",
            sent: false
        })
    );
    assert_eq!(overview(reply)["error"]["code"], "app_gateway_unavailable");
    signal.cancel();
    let cancelled = app_json(&app.endpoint, Method::GET, &[], None, &signal).await;
    assert_eq!(cancelled.unwrap_err().code, "wallpaper_cancelled");
}

fn silk() -> Value {
    json!({"kind": "live", "module": "butler.silk"})
}

fn arguments(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(arguments) => arguments,
        other => panic!("arguments must be an object: {other}"),
    }
}

#[test]
fn arguments_become_the_app_request_with_the_current_project_resolved() {
    let global = request(
        &arguments(json!({"scope": "global", "source": silk()})),
        Some("p1"),
    );
    assert_eq!(
        global.unwrap(),
        json!({"scope": "global", "source": silk()})
    );
    let current = arguments(json!({"scope": "current_project", "source": "inherit"}));
    assert_eq!(
        request(&current, Some("p1")).unwrap(),
        json!({"scope": "project", "project_id": "p1", "source": "inherit"})
    );
    let named = arguments(json!({"scope": "project", "project_id": "p2", "source": silk()}));
    assert_eq!(request(&named, None).unwrap()["project_id"], "p2");

    for (value, current, code) in [
        (
            json!({"scope": "current_project", "source": silk()}),
            None,
            "wallpaper_no_current_project",
        ),
        (
            json!({"scope": "project", "source": silk()}),
            Some("p1"),
            "wallpaper_project_id_required",
        ),
        (
            json!({"scope": "everywhere", "source": silk()}),
            None,
            "wallpaper_scope_invalid",
        ),
        (
            json!({"scope": "global"}),
            None,
            "wallpaper_source_required",
        ),
    ] {
        let (code_found, message) = request(&arguments(value.clone()), current).unwrap_err();
        assert_eq!(code_found, code, "{value}");
        assert!(!message.is_empty());
    }
}

/// A reversible preference write: it needs no Work, runs when asking first
/// and is refused only to a read-only Turn.
#[tokio::test]
async fn set_writes_without_work_unless_the_turn_is_read_only() {
    let change = json!({"scope": "project", "projectId": "p1", "previous": "inherit",
                        "next": silk(), "changed": true});
    let app = stub_app(
        200,
        &json!({"protocol_version": "butler.app.v1", "data": change}),
    )
    .await;
    let signal = CancellationToken::new();
    let call = arguments(json!({"scope": "current_project", "source": silk()}));
    for access in [AccessMode::FullAccess, AccessMode::AskFirst] {
        let result = set(&app.endpoint, &access, &call, Some("p1"), &signal).await;
        assert_eq!(
            result,
            json!({"ok": true, "scope": "project", "projectId": "p1", "previous": "inherit",
                   "next": silk(), "changed": true})
        );
    }
    let received = app.received.lock().clone();
    assert_eq!(received.len(), 2);
    assert_eq!(received[0].line, "POST /internal/wallpaper HTTP/1.1");
    assert!(received[0].head.contains("authorization: bearer secret"));
    assert_eq!(
        received[0].body,
        json!({"scope": "project", "project_id": "p1", "source": silk()})
    );
    let refused = set(
        &app.endpoint,
        &AccessMode::ReadOnly,
        &call,
        Some("p1"),
        &signal,
    )
    .await;
    assert_eq!(refused["ok"], false);
    assert_eq!(refused["error"]["code"], "read_only");
    assert_eq!(app.received.lock().len(), 2);
}

#[tokio::test]
async fn set_refusals_reach_the_model_with_the_field_and_allowed_values() {
    let message = "source.module is user.rain, a user module that cannot be drawn: \
                   0:1: syntax error. Fix its files, call list_wallpapers until its status \
                   is ok, then retry. Allowed: butler.bloom.";
    let refusal = json!({"protocol_version": "butler.app.v1", "error": {
        "code": "wallpaper_module_error", "message": message,
        "field": "source.module", "allowed": ["butler.bloom"]}});
    let app = stub_app(400, &refusal).await;
    let signal = CancellationToken::new();
    let call = arguments(json!({"scope": "global",
                                "source": {"kind": "live", "module": "user.rain"}}));
    let result = set(&app.endpoint, &AccessMode::FullAccess, &call, None, &signal).await;
    assert_eq!(
        result,
        json!({"ok": false, "error": {"code": "wallpaper_module_error", "message": message,
               "field": "source.module", "allowed": ["butler.bloom"]}})
    );

    let invalid = arguments(json!({"scope": "everywhere", "source": silk()}));
    let result = set(
        &app.endpoint,
        &AccessMode::FullAccess,
        &invalid,
        None,
        &signal,
    )
    .await;
    assert_eq!(result["error"]["code"], "wallpaper_scope_invalid");
    assert_eq!(app.received.lock().len(), 1);

    let failing = stub_app(
        500,
        &json!({"error": {"code": "internal_error", "message": "x"}}),
    )
    .await;
    let result = set(
        &failing.endpoint,
        &AccessMode::FullAccess,
        &call,
        None,
        &signal,
    )
    .await;
    assert_eq!(result["error"]["code"], "internal_error");
    let offline = ActiveAppEndpoint::new();
    let result = set(&offline, &AccessMode::FullAccess, &call, None, &signal).await;
    assert_eq!(result["error"]["code"], "app_gateway_unavailable");
}

fn module_call() -> Map<String, Value> {
    arguments(json!({
        "id": "user.rain",
        "manifest": {"id": "user.rain", "engine": 1},
        "shader": "void main(){fragColor=vec4(1.);}"
    }))
}

/// A turn-local write of the user's module folder: every mode but read-only
/// sends it, and the App's check of the saved files comes back as is.
#[tokio::test]
async fn save_sends_the_module_and_returns_the_app_check() {
    let status = json!({"state": "error", "message": "ERROR: 0:3: 'p_x' : undeclared identifier",
                        "checkedAt": "2026-09-28T00:00:00.000Z"});
    let app = stub_app(
        200,
        &json!({"protocol_version": "butler.app.v1",
                "data": {"id": "user.rain", "status": status}}),
    )
    .await;
    let signal = CancellationToken::new();
    for access in [AccessMode::FullAccess, AccessMode::AskFirst] {
        let result = save(&app.endpoint, &access, &module_call(), &signal).await;
        assert_eq!(
            result,
            json!({"ok": true, "id": "user.rain", "status": status})
        );
    }
    let received = app.received.lock().clone();
    assert_eq!(received.len(), 2);
    assert_eq!(
        received[0].line,
        "POST /internal/wallpaper-modules HTTP/1.1"
    );
    assert!(received[0].head.contains("authorization: bearer secret"));
    assert_eq!(received[0].body, Value::Object(module_call()));

    let refused = save(
        &app.endpoint,
        &AccessMode::ReadOnly,
        &module_call(),
        &signal,
    )
    .await;
    assert_eq!(refused["ok"], false);
    assert_eq!(refused["error"]["code"], "read_only");
    assert_eq!(app.received.lock().len(), 2);
}

#[tokio::test]
async fn save_refusals_name_the_field_and_rule() {
    let message = "id butler.rain is reserved: butler.* ids belong to built-in modules.";
    let refusal = json!({"protocol_version": "butler.app.v1", "error": {
        "code": "wallpaper_module_invalid", "message": message, "field": "id"}});
    let app = stub_app(400, &refusal).await;
    let signal = CancellationToken::new();
    let result = save(
        &app.endpoint,
        &AccessMode::FullAccess,
        &module_call(),
        &signal,
    )
    .await;
    assert_eq!(
        result,
        json!({"ok": false, "error": {"code": "wallpaper_module_invalid", "message": message,
               "field": "id"}})
    );

    // A malformed call is refused here, naming the field, and never sent.
    for (patch, field) in [
        (json!({"id": null}), "id"),
        (json!({"id": " "}), "id"),
        (json!({"manifest": "{\"id\": \"user.rain\"}"}), "manifest"),
        (json!({"shader": 7}), "shader"),
    ] {
        let mut call = module_call();
        for (key, value) in patch.as_object().unwrap() {
            if value.is_null() {
                call.remove(key);
            } else {
                call.insert(key.clone(), value.clone());
            }
        }
        let result = save(&app.endpoint, &AccessMode::FullAccess, &call, &signal).await;
        assert_eq!(result["ok"], false, "{patch}");
        assert_eq!(
            result["error"]["code"], "wallpaper_module_invalid",
            "{patch}"
        );
        assert_eq!(result["error"]["field"], field, "{patch}");
        assert!(
            result["error"]["message"]
                .as_str()
                .unwrap()
                .starts_with(field),
            "{result}"
        );
    }
    assert_eq!(app.received.lock().len(), 1);

    let offline = ActiveAppEndpoint::new();
    let result = save(&offline, &AccessMode::FullAccess, &module_call(), &signal).await;
    assert_eq!(result["error"]["code"], "app_gateway_unavailable");
}
