//! SKILL-222 — progressive disclosure through a stub model turn.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::fs;

use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::json;

const PROMPT: &str = "Use project skill project-guide, read its guide.txt, then try ../outside.txt through read_skill_file.";

fn install(
    root: &std::path::Path,
    folder: &str,
    name: &str,
    description: &str,
    body: &str,
) -> std::io::Result<()> {
    let path = root.join(folder);
    fs::create_dir_all(&path)?;
    fs::write(
        path.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: {description}\n---\n{body}\n"),
    )
}

#[tokio::test]
async fn skill_222_catalog_load_resource_and_guard() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SKILL-222")?
        .cassette("SKILL-222")
        .start()
        .await?;
    let created =
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"Skills"}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let project = created.data()["project"]["id"].as_str().unwrap();
    let session =
        s.gw.post(
            "/sessions",
            json!({"kind":"project","title":"Skills","project_id":project}),
        )
        .await?;
    assert_eq!(session.status, 201, "{}", session.text);
    let chat = session.data()["session"]["id"].as_str().unwrap();
    let user = s.sandbox.data.join("skills/default");
    install(
        &user,
        "user-guide",
        "user-guide",
        "User guidance for the turn",
        "USER_BODY",
    )?;
    install(
        &user,
        "project-guide",
        "project-guide",
        "Shadowed user guidance",
        "WRONG_BODY",
    )?;
    for i in 0..48 {
        install(
            &user,
            &format!("zz-extra-{i}"),
            &format!("zz-extra-{i}"),
            "Additional skill for catalog scale",
            "extra",
        )?;
    }
    let project_root = s.sandbox.data.join("skills/projects").join(project);
    // Project session setup otherwise reaches the unrelated first-use Ledger claim failure.
    let ledger_root = s.sandbox.data.join("project-ledger/projects").join(project);
    fs::create_dir_all(&ledger_root)?;
    fs::write(
        ledger_root.join("project.json"),
        serde_json::to_vec(&json!({
            "schema":"project-ledger.project.v1","id":project,"name":"Skills","status":"active",
            "createdAt":"2026-09-29T00:00:00Z","updatedAt":"2026-09-29T00:00:00Z"
        }))?,
    )?;
    fs::write(ledger_root.join("ledger.jsonl"), b"")?;
    install(
        &project_root,
        "project-guide",
        "project-guide",
        "Project guidance for the turn",
        "PROJECT_BODY_222",
    )?;
    fs::write(
        project_root.join("project-guide/guide.txt"),
        "BUNDLED_RESOURCE_222\n",
    )?;
    let (_, turn) = s.turn(chat, PROMPT).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");

    let requests = s.provider()?.requests();
    assert_eq!(requests.len(), 4);
    let first = requests[0]["instructions"].as_str().unwrap_or_default();
    assert!(first.contains("project-guide: Project guidance for the turn"));
    assert!(first.contains("user-guide: User guidance for the turn"));
    assert!(!first.contains("WRONG_BODY") && !first.contains("PROJECT_BODY_222"));
    let catalog = first
        .split("Available skills (call load_skill for instructions):\n")
        .nth(1)
        .unwrap();
    assert!(catalog.len() <= 1_400, "catalog bytes: {}", catalog.len());
    assert_eq!(catalog.matches("project-guide:").count(), 1);
    assert!(requests[1].to_string().contains("PROJECT_BODY_222"));
    assert!(requests[1].to_string().contains("guide.txt"));
    assert!(requests[2].to_string().contains("BUNDLED_RESOURCE_222"));
    assert!(requests[3].to_string().contains("skill_path_invalid"));

    // A changed body with the same mtime must not be re-read on the next turn.
    let skill_path = project_root.join("project-guide/SKILL.md");
    let modified = fs::metadata(&skill_path)?.modified()?;
    fs::write(
        &skill_path,
        "---\nname: project-guide\ndescription: Project guidance for the turn\n---\nCHANGED_BODY_222\n",
    )?;
    fs::OpenOptions::new()
        .write(true)
        .open(&skill_path)?
        .set_times(fs::FileTimes::new().set_modified(modified))?;
    let (_, second_turn) = s.turn(chat, PROMPT).await?;
    assert_eq!(
        second_turn["state"],
        "delivered",
        "{second_turn}; misses: {:?}",
        s.provider()?.misses()
    );
    let repeated = s.provider()?.requests();
    assert_eq!(repeated.len(), 9);
    assert!(repeated[6].to_string().contains("PROJECT_BODY_222"));
    assert!(!repeated[6].to_string().contains("CHANGED_BODY_222"));
    s.finish().await
}
