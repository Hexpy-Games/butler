//! PRJ-04 (#231) — a project's Git state in the API: the project list says
//! whether the folder is a Git repository and its branch (read from HEAD,
//! no process per project), and the project dashboard adds uncommitted
//! changes and the commits ahead of and behind the upstream branch,
//! without ever running a program the repository config names (PRJ-05),
//! and in time when Git is missing or hangs (PRJ-06).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::path::{Path, PathBuf};
use std::process::Command;

use butler_e2e::e2e::scenario::{Scenario, Setup};
use butler_e2e::e2e::{HarnessError, harness_error};
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

/// `project.git` of a repository whose status Git can read. The dashboard
/// gives Git 3 seconds; a cold macOS `/usr/bin/git` shim on a loaded CI
/// runner can take longer on its first calls in a fresh `TMPDIR`, so the
/// dashboard is asked again (the answer is then complete) for up to 30 s.
async fn dashboard_status(s: &Scenario, id: &str, repo: &Path) -> Result<Value, HarnessError> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let git = dashboard_git(s, id).await?;
        if !git["dirty"].is_null() {
            return Ok(git);
        }
        if std::time::Instant::now() > deadline {
            let config = std::fs::read_to_string(repo.join(".git/config")).unwrap_or_default();
            return Err(harness_error(format!(
                "the dashboard never read the status of {}: {git}\n.git/config:\n{config}",
                repo.display()
            )));
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
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
        dashboard_status(&s, &repo_id, &repo).await?,
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
        dashboard_status(&s, &repo_id, &repo).await?,
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

/// Initializes a repository with one commit of `tracked.txt` on `main`.
fn init_repository(folder: &Path) -> Result<(), HarnessError> {
    git(folder, &["init", "-q"]);
    std::fs::write(folder.join("tracked.txt"), "first\n")?;
    git(folder, &["add", "tracked.txt"]);
    git(folder, &["commit", "-q", "-m", "first"]);
    Ok(())
}

/// Writes an executable shell script: `lines`, one per line.
fn script(path: &Path, lines: &[&str]) -> Result<(), HarnessError> {
    std::fs::write(path, format!("#!/bin/sh\n{}\n", lines.join("\n")))?;
    butler_platform::launcher::mark_executable(path)
        .expect("shell scripts run by name on this host")?;
    Ok(())
}

/// PRJ-05 — the dashboard never runs a program the repository's own config
/// names: an fsmonitor hook in `.git/config` is not executed (the status
/// is still read), and a repository with a content filter is not read at
/// all (its status stays unknown; `is_repo` and `branch` come from HEAD).
#[tokio::test]
async fn prj_05_repository_config_never_runs_programs() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("PRJ-05")?.start().await?;
    let (monitored_id, monitored) = project(&s, "Monitored").await?;
    init_repository(&monitored)?;
    let fsmonitor_ran = s.sandbox.root.join("fsmonitor-ran");
    let hook = s.sandbox.root.join("fsmonitor-hook.sh");
    let touch = format!("touch '{}'", fsmonitor_ran.display());
    script(&hook, &[&touch, "exit 1"])?;
    git(
        &monitored,
        &["config", "core.fsmonitor", hook.to_str().unwrap()],
    );
    std::fs::write(monitored.join("draft.txt"), "untracked")?;
    assert_eq!(
        dashboard_status(&s, &monitored_id, &monitored).await?,
        state(true, Some("main"), Some(true), None, None)
    );
    assert!(!fsmonitor_ran.exists(), "the fsmonitor hook ran");

    let (filtered_id, filtered) = project(&s, "Filtered").await?;
    init_repository(&filtered)?;
    let filter_ran = s.sandbox.root.join("filter-ran");
    let filter = s.sandbox.root.join("filter.sh");
    let touch = format!("touch '{}'", filter_ran.display());
    script(&filter, &[&touch, "cat"])?;
    git(
        &filtered,
        &["config", "filter.evil.clean", filter.to_str().unwrap()],
    );
    std::fs::write(filtered.join(".gitattributes"), "* filter=evil\n")?;
    std::fs::write(filtered.join("tracked.txt"), "changed\n")?;
    assert_eq!(
        dashboard_git(&s, &filtered_id).await?,
        state(true, Some("main"), None, None, None)
    );
    assert!(!filter_ran.exists(), "the content filter ran");
    s.finish().await
}

/// PRJ-06 — without Git, or with a Git that hangs, the dashboard still
/// answers in time: `is_repo` and `branch` from HEAD, the rest unknown.
#[tokio::test]
async fn prj_06_missing_or_hanging_git_leaves_status_unknown() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let expected = state(true, Some("main"), None, None, None);

    let setup = Setup::new("PRJ-06-MISSING")?;
    let no_git = setup.sandbox.root.join("no-git-bin");
    std::fs::create_dir_all(&no_git)?;
    let s = setup
        .env("PATH", no_git.display().to_string())
        .start()
        .await?;
    let (id, folder) = project(&s, "No Git").await?;
    init_repository(&folder)?;
    assert_eq!(listed_git(&s, &id).await?, expected, "git missing: list");
    assert_eq!(dashboard_git(&s, &id).await?, expected, "git missing");
    s.finish().await?;

    let setup = Setup::new("PRJ-06-HANG")?;
    let bin = setup.sandbox.root.join("hanging-git-bin");
    std::fs::create_dir_all(&bin)?;
    script(
        &bin.join("git"),
        &[
            "for argument in \"$@\"; do",
            "  [ \"$argument\" = status ] && exec sleep 30",
            "done",
            "exec /usr/bin/git \"$@\"",
        ],
    )?;
    let path = format!("{}:/usr/bin:/bin:/usr/sbin:/sbin", bin.display());
    let s = setup.env("PATH", path).start().await?;
    let (id, folder) = project(&s, "Hanging Git").await?;
    init_repository(&folder)?;
    let started = std::time::Instant::now();
    assert_eq!(dashboard_git(&s, &id).await?, expected, "git hangs");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(8),
        "the dashboard waited {:?} for git",
        started.elapsed()
    );
    s.finish().await
}
