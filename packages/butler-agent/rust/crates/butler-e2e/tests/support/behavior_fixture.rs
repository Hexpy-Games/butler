use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use serde_json::{Value, json};
use std::{fs, path::Path};

pub(super) fn seed(data: &Path, case: &Value) -> Result<(), HarnessError> {
    fs::write(data.join("notes.txt"), "secret: iris-42\n")?;
    let name = case["fixture"].as_str().unwrap_or("fresh");
    if ["persona", "long_persona"].contains(&name) {
        fs::create_dir_all(data.join("personas"))?;
        let text = if name == "long_persona" {
            format!(
                "**Language:** English\n{}\nPersona tail marker: PERSONA-TAIL-IRIS",
                "Historical garden notes. ".repeat(3000)
            )
        } else {
            "**Language:** English\nYour name is Gardener. Include Gardener when introducing yourself. Speak calmly and concisely.".into()
        };
        fs::write(data.join("personas/active.md"), text)?;
    }
    if name == "eol" {
        fs::write(
            data.join("eol.md"),
            "Every assistant reply must include the exact marker EOL-ACK. Preserve user intent.",
        )?;
    }
    if ["rules", "duplicates", "project", "long_rules"].contains(&name) {
        let root = data.join("cognition/memory/rules");
        fs::create_dir_all(&root)?;
        let index = if name == "duplicates" {
            "- [Rule](marker.md)\n- [Same rule](marker.md)\n"
        } else {
            "- [Rule](marker.md)\n"
        };
        fs::write(root.join("INDEX.md"), index)?;
        let text = if name == "long_rules" {
            format!(
                "{}\nRule tail marker: RULE-TAIL-IRIS",
                "Keep all user constraints. ".repeat(5000)
            )
        } else {
            "Outside a project with its own marker rule, the rule marker is GLOBAL-IRIS. Use the project-specific marker within that project.".into()
        };
        fs::write(root.join("marker.md"), text)?;
    }
    Ok(())
}

pub(super) async fn configure(s: &Scenario, case: &Value) -> Result<String, HarnessError> {
    let name = case["fixture"].as_str().unwrap_or("fresh");
    if name == "ko" {
        let response =
            s.gw.patch("/personalization", json!({"response_language":"ko"}))
                .await?;
        assert_eq!(response.status, 200);
    }
    if name == "mcp" {
        let response = s.gw.post("/mcp-servers",json!({"id":"e2e","display_name":"E2E fixture","enabled":true,"transport":"stdio",
            "command":env!("CARGO_BIN_EXE_e2e-mcp-fixture"),"args":[],"env":[{"key":"E2E_MCP_NONCE","source":"literal","value":"mcp-iris-42"}]})).await?;
        assert!(response.status < 300);
        let response = s.gw.post("/mcp-servers/e2e/probe", json!({})).await?;
        assert_eq!(response.status, 200);
    }
    if name != "project" {
        return Ok("general".into());
    }
    let created =
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"Iris garden"}),
        )
        .await?;
    assert_eq!(created.status, 201);
    let project = created.data()["project"]["id"].as_str().unwrap();
    let ledger = s.sandbox.data.join("project-ledger/projects").join(project);
    fs::create_dir_all(&ledger)?;
    fs::write(ledger.join("project.json"),json!({"schema":"project-ledger.project.v1","id":project,"name":"Iris garden","status":"active",
        "createdAt":"2026-09-29T00:00:00Z","updatedAt":"2026-09-29T00:00:00Z"}).to_string())?;
    fs::write(ledger.join("ledger.jsonl"), "")?;
    let memory = s.sandbox.data.join("cognition/memory/projects");
    fs::create_dir_all(&memory)?;
    fs::write(
        memory.join(format!("{project}.md")),
        "Project-specific rule: for this project the rule marker is PROJECT-IRIS. It takes precedence over the global fallback marker.",
    )?;
    let created =
        s.gw.post(
            "/sessions",
            json!({"kind":"project","title":"Iris garden","project_id":project}),
        )
        .await?;
    assert_eq!(created.status, 201);
    Ok(created.data()["session"]["id"].as_str().unwrap().into())
}
