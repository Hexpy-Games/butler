
use std::{collections::HashMap, fs};

use serde_json::{Value, json};

use super::NativeMcpClient;

struct Scratch(std::path::PathBuf);

impl Scratch {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("butler-mcp-management-{}", uuid::Uuid::new_v4()));
        Self(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn registry_crud_redacts_literals_and_patch_retains_secret_placeholders() {
    let scratch = Scratch::new();
    let client = NativeMcpClient::new(scratch.0.clone(), HashMap::new());
    fs::create_dir_all(scratch.0.join("config")).unwrap();
    fs::write(
        scratch.0.join("config/mcp-servers.json"),
        r#"{"version":1,"unknown_root_field":true,"servers":[]}"#,
    )
    .unwrap();
    let saved = client
        .upsert_server(json!({
            "id":" Echo Server ",
            "transport":"stdio",
            "command":"fixture",
            "env":[{"key":"TOKEN","source":"literal","value":"private"},
                   {"key":"REF","source":"env","value":"MCP_REF"}]
        }))
        .await
        .unwrap();
    assert_eq!(saved["id"], "echo-server");
    assert_eq!(saved["env"][0]["redacted"], true);
    assert!(saved["env"][0].get("value").is_none());
    assert_eq!(saved["env"][1]["value"], "MCP_REF");

    let patched = client
        .update_server(
            "echo-server".into(),
            json!({"env":[{"key":"TOKEN","source":"env","value":""}]}),
        )
        .await
        .unwrap();
    assert_eq!(patched["env"].as_array().unwrap().len(), 1);
    assert_eq!(patched["env"][0]["source"], "literal");
    assert_eq!(patched["env"][0]["has_value"], true);

    let list = client.list_servers().unwrap();
    assert_eq!(list["servers"][0]["id"], "echo-server");
    assert_eq!(list["servers"][0]["env"][0]["redacted"], true);

    assert_eq!(
        client.delete_server("missing".into()).await.unwrap()["removed"],
        false
    );
    assert_eq!(
        client.delete_server("echo-server".into()).await.unwrap()["removed"],
        true
    );
    let persisted: Value =
        serde_json::from_slice(&fs::read(scratch.0.join("config/mcp-servers.json")).unwrap())
            .unwrap();
    assert!(persisted.get("unknown_root_field").is_none());
    assert!(persisted["servers"].as_array().unwrap().is_empty());
}
