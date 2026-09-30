//! INS-02 — the CLI-installed Agent: `butler install`, `update --apply`,
//! `rollback`, `versions`, `service install|uninstall|status` and
//! `uninstall`, driven the way a user drives them, in a sandbox with its own
//! `HOME`, `BUTLER_AGENT_HOME` and `BUTLER_DATA`.
//!
//! Login-start is registered with `--files-only` here: launchd and systemd
//! belong to the user, not to the sandbox `HOME`, so the scenarios generate
//! and check the definition and never ask the real service manager to load
//! it.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::agent::{CliOutput, Launch};
use butler_e2e::e2e::install_fixture::{
    Archive, build_archive, release_platform, write_update_manifest,
};
use butler_e2e::e2e::sandbox::Sandbox;
use butler_e2e::e2e::stop_intent::{StopOnDrop, instance_record, read_intent};
use butler_platform::service_registration::{Manager, manager};
use serde_json::Value;

/// A sandboxed user: their home, Agent home and data folder, plus the dev
/// binary that performs the first install.
struct World {
    sandbox: Sandbox,
    launch: Launch,
    agent_home: PathBuf,
    fixtures: PathBuf,
}

impl World {
    fn new(id: &str) -> Result<Self, HarnessError> {
        let sandbox = Sandbox::new(id)?;
        let mut launch = Launch::new(&sandbox)?;
        // Started from the command line, the service keeps its own token.
        launch.use_data_folder_token();
        let agent_home = sandbox.root.join("agent-home");
        launch.set_env("BUTLER_AGENT_HOME", agent_home.display().to_string());
        let path = std::env::join_paths([
            sandbox.home.join(".local/bin").as_path(),
            Path::new("/usr/bin"),
            Path::new("/bin"),
            Path::new("/usr/sbin"),
            Path::new("/sbin"),
        ])
        .map_err(|error| butler_e2e::e2e::harness_error(error.to_string()))?;
        launch.set_env("PATH", path.to_string_lossy());
        let fixtures = sandbox.root.join("fixtures");
        Ok(Self {
            sandbox,
            launch,
            agent_home,
            fixtures,
        })
    }

    /// The archive of `version`, built from the binary under test.
    fn archive(&self, version: &str) -> Result<Archive, HarnessError> {
        build_archive(
            &self.fixtures,
            version,
            &self.sandbox.binary,
            &self.sandbox.resources,
        )
    }

    /// Offers `archives` to `butler update`.
    fn offer(&mut self, archives: &[(Option<String>, &Archive)]) -> Result<(), HarnessError> {
        let manifest = self.fixtures.join("agent-update-manifest.json");
        write_update_manifest(&manifest, archives)?;
        self.launch
            .set_env("BUTLER_UPDATE_MANIFEST", manifest.display().to_string());
        Ok(())
    }

    fn launcher(&self) -> PathBuf {
        self.sandbox.home.join(".local/bin/butler")
    }

    /// `butler-agent <args>` from the dev sandbox installation.
    fn dev(&self, args: &[&str]) -> Result<CliOutput, HarnessError> {
        run(self.launch.command().args(args))
    }

    /// `butler <args>` through the user's launcher.
    fn butler(&self, args: &[&str]) -> Result<CliOutput, HarnessError> {
        run(self.launch.env_command(&self.launcher()).args(args))
    }

    fn pointer(&self, name: &str) -> Option<String> {
        fs::read_link(self.agent_home.join(name))
            .ok()
            .map(|target| target.display().to_string())
    }

    fn record(&self) -> Option<Value> {
        instance_record(&self.sandbox.data)
    }

    /// Stops the service if a failed assertion leaves it running.
    fn stop_on_drop(&self) -> StopOnDrop {
        StopOnDrop(self.launch.clone())
    }
}

fn run(command: &mut std::process::Command) -> Result<CliOutput, HarnessError> {
    let output = command.stdin(Stdio::null()).output()?;
    Ok(CliOutput {
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

fn ok(output: &CliOutput) -> Result<Value, HarnessError> {
    assert_eq!(
        output.code,
        Some(0),
        "exit {:?}\nstdout: {}\nstderr: {}",
        output.code,
        output.stdout,
        output.stderr
    );
    let value = output.json()?;
    assert_eq!(value["ok"], true, "{value}");
    Ok(value)
}

/// The error code of a failed `--json` command.
fn failed(output: &CliOutput) -> Result<String, HarnessError> {
    assert_ne!(
        output.code,
        Some(0),
        "expected a failure: {}",
        output.stdout
    );
    let value = output.json()?;
    assert_eq!(value["ok"], false, "{value}");
    Ok(value["error"]["code"]
        .as_str()
        .unwrap_or_default()
        .to_owned())
}

fn ready_record(world: &World) -> Value {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(record) = world.record().filter(|record| record["state"] == "ready") {
            return record;
        }
        assert!(Instant::now() < deadline, "no ready service record");
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn runs_from(record: &Value, dir: &str) -> bool {
    record["executable"]
        .as_str()
        .is_some_and(|executable| executable.contains(&format!("/{dir}/butler-agent")))
}

/// INS-02 — install, run, update, roll back, register login-start, uninstall.
#[tokio::test]
async fn ins_02_install_update_rollback_uninstall() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut world = World::new("INS-02")?;
    let _stop = world.stop_on_drop();
    let (v1, v2) = (world.archive("0.0.1")?, world.archive("0.0.2")?);
    world.offer(&[(Some(release_platform()), &v2)])?;

    // install --from: a version dir, `current`, and the launcher.
    let installed = ok(&world.dev(&[
        "install",
        "--from",
        &v1.path.display().to_string(),
        "--sha256",
        &v1.sha256,
        "--json",
    ])?)?;
    assert_eq!(installed["data"]["dir"], v1.dir.as_str(), "{installed}");
    assert_eq!(world.pointer("current").as_deref(), Some(v1.dir.as_str()));
    let launcher = fs::read_to_string(world.launcher())?;
    assert_eq!(launcher.lines().nth(1), Some("# butler-native-launcher v1"));
    assert!(launcher.contains(&format!(
        "{}/current/butler-agent",
        world.agent_home.display()
    )));

    // version, from the installed layout.
    let version = ok(&world.butler(&["version", "--json"])?)?;
    assert_eq!(version["data"]["version"], "0.0.1", "{version}");
    assert_eq!(version["data"]["availability"], "installed_manifest");
    let human = world.butler(&["version"])?;
    assert_eq!(human.stdout.trim(), "Butler native 0.0.1");

    // start: the service runs from the installed version.
    ok(&world.butler(&["start", "--json"])?)?;
    let first = ready_record(&world);
    assert!(runs_from(&first, &v1.dir), "{first}");

    // update --apply: the service restarts once, on the new version.
    let dry = ok(&world.butler(&["update", "--dry-run", "--json"])?)?;
    assert_eq!(dry["data"]["update_available"], true, "{dry}");
    assert_eq!(world.pointer("current").as_deref(), Some(v1.dir.as_str()));
    let refused = world.butler(&["update", "--apply", "--json"])?;
    assert_eq!(failed(&refused)?, "confirmation_required");
    let updated = ok(&world.butler(&["update", "--apply", "--yes", "--json"])?)?;
    assert_eq!(
        updated["data"]["activation_status"], "activated",
        "{updated}"
    );
    assert_eq!(updated["data"]["service"]["restarted"], true, "{updated}");
    assert_eq!(world.pointer("current").as_deref(), Some(v2.dir.as_str()));
    assert_eq!(world.pointer("previous").as_deref(), Some(v1.dir.as_str()));
    let second = ready_record(&world);
    assert!(runs_from(&second, &v2.dir), "{second}");
    assert_ne!(
        second["nonce"], first["nonce"],
        "the service did not restart"
    );
    assert!(
        read_intent(&world.sandbox.data).is_none(),
        "stop intent left over"
    );
    // No unintended restart follows: the instance stays the same.
    std::thread::sleep(Duration::from_secs(3));
    let settled = ready_record(&world);
    assert_eq!(
        settled["nonce"], second["nonce"],
        "the service restarted again"
    );
    assert_eq!(settled["pid"], second["pid"]);
    assert!(
        fs::read_dir(world.sandbox.data.join("updates/artifacts"))
            .map_or(true, |mut entries| entries.next().is_none()),
        "the staged archive was kept after it was installed"
    );
    let latest = ok(&world.butler(&["update", "--check", "--json"])?)?;
    assert_eq!(latest["data"]["update_available"], false, "{latest}");

    // versions marks the active one.
    let versions = ok(&world.butler(&["versions", "--json"])?)?;
    let listed: Vec<_> = versions["data"]["versions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["version"].as_str().unwrap().to_owned(),
                entry["active"] == true,
            )
        })
        .collect();
    assert_eq!(
        listed,
        [("0.0.2".to_owned(), true), ("0.0.1".to_owned(), false)],
        "{versions}"
    );

    // rollback: back on the first version, the service restarted onto it.
    assert_eq!(
        failed(&world.butler(&["rollback", "--json"])?)?,
        "confirmation_required"
    );
    let rolled = ok(&world.butler(&["rollback", "--yes", "--json"])?)?;
    assert_eq!(rolled["data"]["service"]["restarted"], true, "{rolled}");
    assert_eq!(world.pointer("current").as_deref(), Some(v1.dir.as_str()));
    let third = ready_record(&world);
    assert!(runs_from(&third, &v1.dir), "{third}");
    let version = ok(&world.butler(&["version", "--json"])?)?;
    assert_eq!(version["data"]["version"], "0.0.1");

    login_start_registration(&world)?;

    // uninstall keeps the data folder unless told to purge it.
    let unsafe_purge = world.butler(&[
        "uninstall",
        "--purge-data",
        "--yes",
        "--data",
        &world.sandbox.home.display().to_string(),
        "--json",
    ])?;
    assert_eq!(failed(&unsafe_purge)?, "unsafe_path");
    assert!(world.sandbox.home.is_dir());
    assert_eq!(
        failed(&world.butler(&["uninstall", "--json"])?)?,
        "confirmation_required"
    );
    let removed = ok(&world.butler(&[
        "uninstall",
        "--keep-data",
        "--yes",
        "--files-only",
        "--json",
    ])?)?;
    assert_eq!(removed["data"]["serviceStopped"], true, "{removed}");
    assert_eq!(
        removed["data"]["loginStart"]["state"], "removed",
        "{removed}"
    );
    assert_eq!(
        removed["data"]["launchers"]["command"], "removed",
        "{removed}"
    );
    assert!(!world.agent_home.exists(), "the Agent home is still there");
    assert!(!world.launcher().exists(), "the launcher is still there");
    assert!(world.record().is_none(), "the service is still recorded");
    assert!(
        world.sandbox.data.join("config").is_dir(),
        "data was removed"
    );

    // --purge-data removes the data folder after an install.
    ok(&world.dev(&[
        "install",
        "--from",
        &v1.path.display().to_string(),
        "--no-restart",
        "--json",
    ])?)?;
    let purged = ok(&world.butler(&["uninstall", "--purge-data", "--yes", "--json"])?)?;
    assert_eq!(purged["data"]["data"]["purged"], true, "{purged}");
    assert!(
        !world.sandbox.data.exists(),
        "the data folder survived --purge-data"
    );
    Ok(())
}

/// `service install | status | uninstall` write, report and remove the
/// login-start definition, and run nothing.
fn login_start_registration(world: &World) -> Result<(), HarnessError> {
    let installed = ok(&world.butler(&["service", "install", "--files-only", "--json"])?)?;
    let definition = PathBuf::from(installed["data"]["definition"].as_str().unwrap());
    assert!(
        definition.starts_with(&world.sandbox.home),
        "the definition was written outside the sandbox home: {}",
        definition.display()
    );
    let text = fs::read_to_string(&definition)?;
    let program = format!("{}/current/butler-agent", world.agent_home.display());
    assert!(text.contains(&program), "{text}");
    assert!(text.contains("--if-absent"), "{text}");
    match manager() {
        Manager::Launchd => {
            assert!(text.contains("com.hexpy.butler.agent"), "{text}");
            assert!(text.contains("<key>SuccessfulExit</key>"), "{text}");
        }
        Manager::SystemdUser => assert!(text.contains("Restart=on-failure"), "{text}"),
        Manager::TaskScheduler => panic!("Windows is not supported yet"),
    }
    let status = ok(&world.butler(&["service", "status", "--json"])?)?;
    assert_eq!(status["data"]["registered"], true, "{status}");
    ok(&world.butler(&["service", "uninstall", "--files-only", "--json"])?)?;
    assert!(!definition.exists(), "the definition survived uninstall");
    let status = ok(&world.butler(&["service", "status", "--json"])?)?;
    assert_eq!(status["data"]["registered"], false, "{status}");
    // Registered again, it is the installation's to remove at uninstall.
    ok(&world.butler(&["service", "install", "--files-only", "--json"])?)?;
    assert!(definition.exists());
    Ok(())
}

/// INS-08 — a service the App supervises comes back up on the new version:
/// `update --apply` restarts it with the stop-intent `restart` (the App
/// starts the replacement), and the App, which launches `AGENT_HOME/current`
/// each time, gets the version just activated.
#[tokio::test]
async fn ins_08_update_restarts_an_app_supervised_service_on_the_new_version()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut world = World::new("INS-08")?;
    let _stop = world.stop_on_drop();
    let (v1, v2) = (world.archive("0.0.1")?, world.archive("0.0.2")?);
    world.offer(&[(Some(release_platform()), &v2)])?;
    ok(&world.dev(&[
        "install",
        "--from",
        &v1.path.display().to_string(),
        "--json",
    ])?)?;

    // The App: it launches whatever `current` names, at every launch.
    let current = world.agent_home.join("current");
    let mut app = Launch::new(&world.sandbox)?;
    for (key, value) in &world.launch.env {
        if matches!(
            key.as_str(),
            "BUTLER_AGENT_HOME" | "PATH" | "BUTLER_UPDATE_MANIFEST"
        ) {
            app.set_env(key, value.clone());
        }
    }
    app.binary = current.join("butler-agent");
    app.install = current.clone();
    app.resources = current.join("resources");
    app.use_app_supervisor()?;
    let (mut agent, _gateway) = butler_e2e::e2e::agent::Agent::start(app.clone()).await?;
    let first = ready_record(&world);
    assert!(runs_from(&first, &v1.dir), "{first}");
    assert_eq!(first["app_supervised"], true, "{first}");

    let mut command = app.env_command(&world.launcher());
    command.args(["update", "--apply", "--yes", "--json"]);
    let output = agent.command_reaping(command, || {}).await?;
    let updated = ok(&CliOutput {
        code: output.code,
        stdout: output.stdout,
        stderr: output.stderr,
    })?;
    assert_eq!(updated["data"]["service"]["restarted"], true, "{updated}");
    let second = ready_record(&world);
    assert!(runs_from(&second, &v2.dir), "{second}");
    assert_eq!(second["app_supervised"], true, "{second}");
    assert_ne!(
        second["nonce"], first["nonce"],
        "the service did not restart"
    );
    assert!(
        read_intent(&world.sandbox.data).is_none(),
        "stop intent left over"
    );
    std::thread::sleep(Duration::from_secs(3));
    assert_eq!(ready_record(&world)["nonce"], second["nonce"]);
    Ok(())
}
