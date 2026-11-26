//! Main-only canonical download workspace and owner fencing, offline stub tier.
use butler_e2e::e2e::{HarnessError, scenario::Setup, security::AdminClient};
use reqwest::Method;
use serde_json::json;

#[tokio::test]
async fn browser_download_workspace_is_main_only_without_caller_paths() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-DOWNLOADS")?.start().await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    admin.send(Method::POST, "/internal/browser-host/events", Some(json!({"tabs":[
        {"id":"download-tab","owner":"conversation:general","profile":"signed_out","epoch":1,"holder":"agent"}
    ]})), &[]).await?;
    let route = "/internal/browser-host/downloads";
    let context = admin
        .send(
            Method::POST,
            route,
            Some(json!({"op":"prepare","session":"general","tab":"download-tab"})),
            &[],
        )
        .await?;
    assert_eq!(context.status, 200, "{}", context.text);
    let context: serde_json::Value = serde_json::from_str(&context.text)?;
    let root = std::path::PathBuf::from(context["workspace_path"].as_str().unwrap());
    assert!(root.starts_with(&s.sandbox.root));
    std::fs::create_dir_all(root.join("downloads"))?;
    let invoice = b"%PDF-1.4\nInvoice 42\n%%EOF\n";
    std::fs::write(root.join("downloads/invoice.pdf"), invoice)?;
    let published = admin.send(Method::POST, route, Some(json!({"op":"publish","session":"general","tab":"download-tab","filename":"invoice.pdf"})), &[]).await?;
    assert_eq!(published.status, 400, "{}", published.text);
    let artifacts = s.gw.get("/artifacts?session_id=general").await?;
    assert!(
        !artifacts.text.contains("invoice.pdf"),
        "{}",
        artifacts.text
    );
    let refused = admin
        .send(
            Method::POST,
            route,
            Some(json!({"op":"prepare","session":"other","tab":"download-tab"})),
            &[],
        )
        .await?;
    assert_eq!(refused.status, 403, "{}", refused.text);
    let denied =
        s.gw.post(
            route,
            json!({"op":"prepare","session":"general","tab":"download-tab"}),
        )
        .await?;
    assert_eq!(denied.status, 403);
    s.finish().await
}
