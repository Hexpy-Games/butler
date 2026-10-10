//! P3 registry, root mount, WebSocket admission and contained archive cleanup.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{HarnessError, scenario::Setup, security::AdminClient};
use reqwest::Method;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}
async fn call(
    admin: &AdminClient,
    session: &str,
    op: &str,
    args: Value,
) -> Result<Value, HarnessError> {
    let response = admin
        .send(
            Method::POST,
            "/internal/browser/calls",
            Some(json!({"op":op,"session":session,"args":args})),
            &[],
        )
        .await?;
    assert_eq!(response.status, 200);
    Ok(response.body)
}
async fn websocket(origin: &str, cookie: &str) -> String {
    let url = reqwest::Url::parse(origin).unwrap();
    let authority = format!("127.0.0.1:{}", url.port().unwrap());
    let mut stream = tokio::net::TcpStream::connect(&authority).await.unwrap();
    stream.write_all(format!("GET /hmr HTTP/1.1\r\nHost: {authority}\r\nOrigin: {origin}\r\nCookie: {cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").as_bytes()).await.unwrap();
    let mut result = vec![0; 4096];
    let n = tokio::time::timeout(std::time::Duration::from_secs(5), stream.read(&mut result))
        .await
        .unwrap()
        .unwrap();
    String::from_utf8_lossy(&result[..n]).into_owned()
}
async fn listening(port: u16) {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_err()
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("fixture child is listening");
}
#[tokio::test]
async fn preview_registry_proxies_only_registered_ports_and_archive_kills_descendants()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    // The fixture uses the runner's existing Bun; HOME and data stay isolated.
    let setup = Setup::new("BROWSER-PREVIEW")?.env(
        "PATH",
        std::env::var("PATH").expect("runner PATH is required"),
    );
    let cwd = setup.sandbox.workspace.clone();
    std::fs::write(
        cwd.join("server.mjs"),
        r#"
const port=Number(process.argv[2]),child=Number(process.argv[3]);
if(child)Bun.spawn([process.execPath,import.meta.filename,String(child)],{stdout:"ignore",stderr:"ignore"});
process.stdout.write("x".repeat(100000)+"TAIL");
if(process.argv[4]==="pending")await Bun.sleep(10000);
Bun.serve({hostname:"127.0.0.1",port,fetch(request,server){
 if(new URL(request.url).pathname==="/hmr" && server.upgrade(request))return;
 return new Response(JSON.stringify({path:new URL(request.url).pathname,cookie:request.headers.get("cookie"),auth:request.headers.get("authorization"),body:"preview"}),{headers:{"content-type":"application/json"}});
},websocket:{open(ws){ws.send("ready")},message(ws,message){ws.send(message)}}});
"#,
    )?;
    let s = setup.start().await?;
    let created =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Preview"}))
            .await?;
    let session = created.data()["session"]["id"].as_str().unwrap().to_owned();
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let (first, child, second, third) = (port(), port(), port(), port());
    let command = |port, child| format!("bun server.mjs {port} {child}");
    let args = |id: &str, port, child| json!({"agent":"preview-agent","preview_id":id,"command":command(port,child),"cwd":cwd,"port":port});
    let started = call(
        &admin,
        &session,
        "preview.start",
        args("preview-first", first, child),
    )
    .await?;
    assert_eq!(started["status"], "ok", "{}", started["reason"]);
    assert!(started["untrusted_log"].as_str().unwrap().len() <= 65536);
    assert!(started["untrusted_log"].as_str().unwrap().ends_with("TAIL"));
    assert_eq!(
        call(
            &admin,
            &session,
            "preview.start",
            args("preview-second", second, 0)
        )
        .await?["status"],
        "ok"
    );
    assert_eq!(
        call(
            &admin,
            &session,
            "preview.start",
            args("preview-third", third, 0)
        )
        .await?["reason"],
        "preview_budget_exhausted"
    );
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let url = started["url"].as_str().unwrap();
    let origin = reqwest::Url::parse(url)
        .unwrap()
        .origin()
        .ascii_serialization();
    let bootstrap = client.get(url).send().await?;
    assert_eq!(bootstrap.status(), 303);
    assert_eq!(bootstrap.headers()["location"], "/");
    let cookie = bootstrap.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let served = client
        .get(format!("{origin}/assets/main.js?port={third}"))
        .header("cookie", &cookie)
        .header("authorization", "Bearer fixture-secret")
        .send()
        .await?;
    let body: Value = served.json().await?;
    assert_eq!(body["path"], "/assets/main.js");
    assert_eq!(body["body"], "preview");
    assert!(body["cookie"].is_null() && body["auth"].is_null());
    assert!(
        websocket(&origin, &cookie)
            .await
            .starts_with("HTTP/1.1 101")
    );
    assert!(
        websocket(&origin, "butler_preview=unregistered")
            .await
            .starts_with("HTTP/1.1 403")
    );
    assert_eq!(
        client
            .get(format!("{origin}/?port={third}"))
            .send()
            .await?
            .status(),
        404
    );
    assert_eq!(
        client
            .get(format!("{origin}/__p/unregistered"))
            .send()
            .await?
            .status(),
        403
    );
    assert_eq!(
        call(
            &admin,
            "another-session",
            "preview.stop",
            json!({"agent":"preview-agent","preview_id":"preview-first"})
        )
        .await?["reason"],
        "not_your_preview"
    );
    let stopped = call(
        &admin,
        &session,
        "preview.stop",
        json!({"agent":"preview-agent","preview_id":"preview-second"}),
    )
    .await?;
    assert_eq!(stopped["status"], "ok");
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", child))
            .await
            .is_ok()
    );
    assert_eq!(
        s.gw.post(&format!("/sessions/{session}/archive"), json!({}))
            .await?
            .status,
        200
    );
    for port in [first, child, second] {
        assert!(
            tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_err(),
            "descendant {port} survived"
        );
    }
    assert_eq!(
        client
            .get(format!("{origin}/"))
            .header("cookie", &cookie)
            .send()
            .await?
            .status(),
        403
    );
    assert_eq!(
        call(
            &admin,
            &session,
            "preview.start",
            args("preview-late", third, 0)
        )
        .await?["reason"],
        "session_closed"
    );
    assert_eq!(
        s.gw.patch(&format!("/sessions/{session}"), json!({"archived":false}))
            .await?
            .status,
        200
    );
    assert_eq!(
        call(
            &admin,
            &session,
            "preview.start",
            args("preview-restored", third, 0)
        )
        .await?["status"],
        "ok"
    );
    s.gw.post(&format!("/sessions/{session}/archive"), json!({}))
        .await?;
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", third))
            .await
            .is_err()
    );
    let created =
        s.gw.post(
            "/sessions",
            json!({"kind":"chat","title":"Pending preview"}),
        )
        .await?;
    let pending_session = created.data()["session"]["id"].as_str().unwrap();
    let (pending_port, pending_child, independent_port) = (port(), port(), port());
    let mut pending = args("preview-pending", pending_port, pending_child);
    pending["command"] = json!(format!("{} pending", command(pending_port, pending_child)));
    let (pending, archived) = tokio::join!(
        call(&admin, pending_session, "preview.start", pending),
        async {
            listening(pending_child).await;
            let mut independent = args("preview-independent", independent_port, 0);
            independent["agent"] = json!("independent-agent");
            assert_eq!(
                call(&admin, pending_session, "preview.start", independent).await?["status"],
                "ok"
            );
            assert!(
                tokio::net::TcpStream::connect(("127.0.0.1", pending_child))
                    .await
                    .is_ok()
            );
            s.gw.post(&format!("/sessions/{pending_session}/archive"), json!({}))
                .await
        }
    );
    assert_eq!(archived?.status, 200);
    assert_eq!(pending?["status"], "not_dispatched");
    for port in [pending_port, pending_child, independent_port] {
        assert!(
            tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_err()
        );
    }
    s.finish().await
}
