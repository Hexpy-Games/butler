//! MXC acceptance matrix, executed by the pinned Medium-IL desktop bundle.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
mod boundaries;
mod latency;
mod project_boundaries;
mod project_write;
mod tools;
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use butler_platform::command_sandbox::{self, Invocation};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::{Command, Output},
};

fn desktop() -> bool {
    !command_sandbox::POSIX_SHELL
        && std::env::var("BUTLER_E2E_WINDOWS_SANDBOX_DESKTOP").as_deref() == Ok("1")
}
struct Fixture {
    setup: Setup,
    root: PathBuf,
    env: HashMap<String, String>,
    scratch: [PathBuf; 3],
}
impl Fixture {
    fn new(row: &str) -> Result<Self, HarnessError> {
        let setup = Setup::new(row)?;
        let home = &setup.sandbox.home;
        let root = home.join("projects/프로젝트 Project");
        let scratch = [
            setup.sandbox.data.join("tmp/project-write"),
            setup.sandbox.data.join("cache/project-write"),
            setup.sandbox.data.join("artifacts/generated"),
        ];
        for dir in [&root, &home.join("roaming"), &home.join("local")] {
            std::fs::create_dir_all(dir)?;
        }
        let mut env: HashMap<String, String> = std::env::vars()
            .map(|(key, value)| (key.to_ascii_uppercase(), value))
            .collect();
        for (key, path) in [
            ("HOME", home.clone()),
            ("USERPROFILE", home.clone()),
            ("APPDATA", home.join("roaming")),
            ("LOCALAPPDATA", home.join("local")),
            ("BUTLER_DATA", setup.sandbox.data.clone()),
        ] {
            env.insert(key.into(), path.display().to_string());
        }
        env.insert("BUTLER_COMMAND_TIMEOUT_MS".into(), "30000".into());
        Ok(Self {
            setup,
            root,
            env,
            scratch,
        })
    }
    fn prepare(&self, script: &str) -> Invocation {
        let secrets = command_sandbox::discover_project_secrets(&self.root).unwrap();
        command_sandbox::windows_prepare_project_write(
            script,
            &self.env,
            &self.root,
            &self
                .scratch
                .iter()
                .map(PathBuf::as_path)
                .collect::<Vec<_>>(),
            &secrets.iter().map(PathBuf::as_path).collect::<Vec<_>>(),
        )
        .unwrap()
    }
    fn launch(&self, invocation: &Invocation) -> Output {
        let mut command = Command::new(&invocation.program);
        command_sandbox::add_arguments(&mut command, invocation);
        command
            .current_dir(&self.root)
            .envs(&self.env)
            .output()
            .unwrap()
    }
    fn run(&self, script: &str) -> Output {
        self.launch(&self.prepare(script))
    }
    fn pass(&self, script: &str) -> Output {
        let output = self.run(script);
        assert!(output.status.success(), "{script}: {output:?}");
        output
    }
    fn deny(&self, script: &str) -> Output {
        let output = self.run(script);
        assert!(
            !output.status.success(),
            "escape succeeded: {script}: {output:?}"
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            ![
                "command_observation_isolation_unavailable",
                command_sandbox::EXECUTION_FAILURE_MARKER,
                command_sandbox::EXECUTION_TIMEOUT_MARKER,
            ]
            .iter()
            .any(|marker| stderr.contains(marker)),
            "helper failure or timeout does not prove a boundary: {output:?}"
        );
        output
    }
    fn finish(mut self) {
        self.setup.sandbox.mark_success();
    }
}
fn quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "''"))
}
