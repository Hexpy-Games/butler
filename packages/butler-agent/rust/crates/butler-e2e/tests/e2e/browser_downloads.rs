//! Main-only canonical workspace publication and owner fencing, offline stub tier.
use butler_e2e::e2e::{HarnessError, scenario::Setup, security::AdminClient};
use reqwest::Method;
use serde_json::json;

#[tokio::test]
async fn browser_downloads_become_session_outputs_without_caller_paths() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-DOWNLOADS")?.start().await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    admin.send(Method::POST, "/internal/browser-host/events", Some(json!({"tabs":[
        {"id":"download-tab","owner":"conversation:general","profile":"signed_out","epoch":1,"holder":"user"}
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
    assert_eq!(published.status, 200, "{}", published.text);
    let output: serde_json::Value = serde_json::from_str(&published.text)?;
    let artifacts = s.gw.get("/artifacts?session_id=general").await?;
    assert!(
        artifacts
            .text
            .contains(output["output_id"].as_str().unwrap())
    );
    let library = s.gw.get("/library?kind=output").await?;
    assert!(library.text.contains(output["output_id"].as_str().unwrap()));
    let view = s.gw.get(output["view"].as_str().unwrap()).await?;
    let bytes = reqwest::get(view.data()["url"].as_str().unwrap())
        .await?
        .bytes()
        .await?;
    assert_eq!(bytes.as_ref(), invoice);
    for (session, filename, status) in [
        ("other", "invoice.pdf", 403),
        ("general", "../outside.exe", 400),
    ] {
        let refused = admin.send(Method::POST, route, Some(json!({"op":"publish","session":session,"tab":"download-tab","filename":filename})), &[]).await?;
        assert_eq!(refused.status, status, "{}", refused.text);
    }
    let denied =
        s.gw.post(
            route,
            json!({"op":"prepare","session":"general","tab":"download-tab"}),
        )
        .await?;
    assert_eq!(denied.status, 403);
    s.finish().await
}
