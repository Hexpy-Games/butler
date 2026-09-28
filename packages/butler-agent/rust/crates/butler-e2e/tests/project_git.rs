//! PRJ-04 (#231) — a project's Git state in the API: the project list says
//! whether the folder is a Git repository and its branch (read from HEAD,
//! no process per project), and the project dashboard adds uncommitted
//! changes and the commits ahead of and behind the upstream branch.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::path::{Path, PathBuf};
use std::process::Command;

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::scenario::{Scenario, Setup};
use serde_json::{Value, json};

/// Runs `git` in `folder` with a fixed identity; panics on failure.
fn git(folder: &Path, args: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(folder)
        .args([
            "-c",
            "user.name=Butler E2E",
            "-c",
            "user.email=e2e@example.invalid",
            "-c",
            "init.defaultBranch=main",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// Whether `folder` is inside a Git work tree (an ancestor may be one).
fn inside_repository(folder: &Path) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(folder)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .is_ok_and(|output| output.status.success())
}

/// Creates a scratch project; its id and folder.
async fn project(s: &Scenario, name: &str) -> Result<(String, PathBuf), HarnessError> {
    let created =
        s.gw.post(
            "/projects",
            json!({"source": "scratch", "display_name": name}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let id = created.data()["project"]["id"].as_str().unwrap().to_owned();
    let folder = s.sandbox.data.join("workspaces/projects").join(name);
    assert!(folder.is_dir(), "no project folder at {}", folder.display());
    Ok((id, folder))
}

/// `git` of the project in `GET /projects`.
async fn listed_git(s: &Scenario, id: &str) -> Result<Value, HarnessError> {
    let reply = s.gw.get("/projects").await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let project = reply.data()["projects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|project| project["id"] == id)
        .unwrap_or_else(|| panic!("{id} not listed: {}", reply.text))
        .clone();
    Ok(project["git"].clone())
}

/// `project.git` of the project dashboard.
async fn dashboard_git(s: &Scenario, id: &str) -> Result<Value, HarnessError> {
    let reply = s.gw.get(&format!("/projects/{id}/dashboard")).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data()["project"]["git"].clone())
}

/// The expected `git` object.
fn state(
    is_repo: bool,
    branch: Option<&str>,
    dirty: Option<bool>,
    ahead: Option<u32>,
    behind: Option<u32>,
) -> Value {
    json!({"is_repo": is_repo, "branch": branch, "dirty": dirty, "ahead": ahead, "behind": behind})
}

/// PRJ-04 — the list shows `is_repo` and `branch` only; the dashboard also
/// shows `dirty`, `ahead` and `behind` (null without an upstream); a
/// detached HEAD has no branch; a plain folder is not a repository.
#[tokio::test]
async fn prj_04_project_git_state_in_list_and_dashboard() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("PRJ-04")?.start().await?;
    let (repo_id, repo) = project(&s, "Garden Repo").await?;
    let (plain_id, plain) = project(&s, "Garden Notes").await?;
    git(&repo, &["init", "-q"]);
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "first"]);
    let listed_main = state(true, Some("main"), None, None, None);
    assert_eq!(listed_git(&s, &repo_id).await?, listed_main);
    assert_eq!(
        dashboard_git(&s, &repo_id).await?,
        state(true, Some("main"), Some(false), None, None)
    );

    let remote = s.sandbox.root.join("remote.git");
    let remote = remote.to_str().unwrap();
    git(&s.sandbox.root, &["init", "-q", "--bare", remote]);
    git(&repo, &["remote", "add", "origin", remote]);
    git(&repo, &["push", "-q", "-u", "origin", "main"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "second"]);
    std::fs::write(repo.join("draft.txt"), "not committed")?;
    assert_eq!(
        dashboard_git(&s, &repo_id).await?,
        state(true, Some("main"), Some(true), Some(1), Some(0))
    );
    assert_eq!(
        listed_git(&s, &repo_id).await?,
        listed_main,
        "the list must stay cheap"
    );

    git(&repo, &["checkout", "-q", "--detach"]);
    assert_eq!(listed_git(&s, &repo_id).await?["branch"], Value::Null);
    assert_eq!(dashboard_git(&s, &repo_id).await?["branch"], Value::Null);

    let plain_is_repo = inside_repository(&plain);
    let plain_git = dashboard_git(&s, &plain_id).await?;
    assert_eq!(plain_git["is_repo"], plain_is_repo, "{plain_git}");
    if !plain_is_repo {
        assert_eq!(plain_git, state(false, None, None, None, None));
    }
    s.finish().await
}
