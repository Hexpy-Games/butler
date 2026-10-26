use super::*;
use std::process::Command;

pub(super) struct Repo {
    pub work: PathBuf,
    pub bare: PathBuf,
    pub home: PathBuf,
    pub url: String,
}
impl Repo {
    pub(super) fn new(home: &Path, name: &str, plugin: bool) -> Result<Self, HarnessError> {
        let work = home.join(name);
        let bare = home.join(format!("{name}.git"));
        let url = url::Url::from_file_path(&bare).unwrap().to_string();
        let repo = Self {
            work,
            bare,
            home: home.to_owned(),
            url,
        };
        repo.git(&repo.home, &["init", "--bare", repo.bare.to_str().unwrap()]);
        repo.git(&repo.bare, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        repo.git(
            &repo.home,
            &["clone", &repo.url, repo.work.to_str().unwrap()],
        );
        repo.git(&repo.work, &["config", "user.name", "Fixture author"]);
        repo.git(
            &repo.work,
            &["config", "user.email", "fixture@example.invalid"],
        );
        repo.git(&repo.work, &["config", "core.autocrlf", "false"]);
        if plugin {
            package(home, name)?;
        }
        Ok(repo)
    }
    pub(super) fn git(&self, cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .env("HOME", &self.home)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.home.join(".gitconfig"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }
    pub(super) fn publish(&self) -> String {
        self.git(&self.work, &["add", "--all"]);
        self.git(&self.work, &["commit", "-m", "Package revision"]);
        self.git(&self.work, &["push", "origin", "main"]);
        self.git(&self.work, &["rev-parse", "HEAD"])
    }
    pub(super) fn version(&self, version: &str) {
        edit(&self.work.join("plugin.json"), |v| {
            v["version"] = json!(version);
        });
    }
    pub(super) fn nonce(&self, nonce: &str) {
        edit(&self.work.join("mcp.json"), |v| {
            v["mcpServers"]["notes"]["env"]["E2E_MCP_NONCE"] = json!(nonce);
        });
    }
}
pub(super) fn edit(path: &Path, apply: impl FnOnce(&mut Value)) {
    let mut value: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    apply(&mut value);
    fs::write(path, value.to_string()).unwrap();
}
pub(super) fn git_setup(name: &str) -> Result<Setup, HarnessError> {
    let setup = setup(name)?;
    let config = setup.sandbox.home.join(".gitconfig");
    fs::write(&config, "[protocol \"file\"]\n\tallow = always\n")?;
    Ok(setup
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", config.to_string_lossy()))
}
pub(super) async fn inspect_source(s: &Scenario, source: Value) -> Result<Value, HarnessError> {
    let r = api(s, Method::POST, "/plugins/inspect", Some(source)).await?;
    assert_eq!(r.status, 200, "{r:?}");
    Ok(r.data().clone())
}
pub(super) async fn install_source(s: &Scenario, source: Value) -> Result<Value, HarnessError> {
    let i = inspect_source(s, source).await?;
    let r=api(s,Method::POST,"/plugins/install",Some(json!({"staging_id":i["staging_id"],"digest":i["digest"],"revision":revision(s).await?}))).await?;
    assert_eq!(r.status, 200, "{r:?}");
    Ok(i)
}
pub(super) async fn check(s: &Scenario, force: bool) -> Result<Value, HarnessError> {
    let r = api(
        s,
        Method::POST,
        "/plugins/helper/check",
        Some(json!({"force":force,"revision":revision(s).await?})),
    )
    .await?;
    assert_eq!(r.status, 200, "{r:?}");
    Ok(r.data().clone())
}
pub(super) async fn inventory(s: &Scenario) -> Result<Value, HarnessError> {
    Ok(api(s, Method::GET, "/plugins", None).await?.data()["plugins"][0].clone())
}
pub(super) async fn echo(s: &Scenario, nonce: &str) -> Result<(), HarnessError> {
    let before = s.provider()?.requests().len();
    s.provider()?.set_chat_responder(respond);
    let (_, turn) = s.turn("general", "Use the package tool.").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let requests = s.provider()?.requests();
    assert!(
        requests[before..]
            .iter()
            .any(|v| v.to_string().contains(&format!("e2e token {nonce}"))),
        "missing nonce {nonce}"
    );
    Ok(())
}
pub(super) fn empty(path: &Path) -> bool {
    !path.exists() || fs::read_dir(path).unwrap().next().is_none()
}

pub(super) fn respond(body: &Value) -> Option<butler_e2e::e2e::cassette::ResponseRecord> {
    let mut body = body.clone();
    let input = body["input"].as_array_mut()?;
    if let Some(last) = input.iter().rposition(|v| v["role"] == "user") {
        input.drain(..last);
    }
    stub::run(&body)
}

pub(super) fn git_digest(repo: &Repo) -> Result<String, HarnessError> {
    use sha2::{Digest, Sha256};
    let entries = repo.git(&repo.work, &["ls-files", "--stage"]);
    let mut hash = Sha256::new();
    for line in entries.lines() {
        let (metadata, path) = line.split_once('\t').unwrap();
        let mode = if metadata.starts_with("100755") {
            "755"
        } else {
            "644"
        };
        let content = Sha256::digest(fs::read(repo.work.join(path))?);
        hash.update(format!("{path}\0{mode}\0{content:x}\n"));
    }
    Ok(format!("{:x}", hash.finalize()))
}
