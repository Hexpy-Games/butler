//! The Butler App as the agent's process supervisor: the App-only start
//! environment, the foreground lease on stdin, and the exit handling that
//! tells an announced restart from a crash (`D/state/agent-stop-intent.json`).

use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::Value;

use super::{Agent, Launch};
use crate::e2e::HarnessError;

const STOP_INTENT_SCHEMA: &str = "butler.agent-stop-intent.v1";

impl Launch {
    /// Starts the agent as the Butler App does: the gateway token in D's App
    /// local-auth file, the foreground lease on stdin, the App gateway forced
    /// on (`BUTLER_APP_BUNDLED_SUPERVISOR`), and the harness answering an
    /// announced restart the way the App's supervisor must.
    pub fn use_app_supervisor(&mut self) -> Result<(), HarnessError> {
        self.use_app_local_auth_file()?;
        self.app_supervisor = true;
        Ok(())
    }

    /// The command that starts the service process. Only this command gets
    /// the App-only variables; CLI commands run with [`Launch::command`].
    pub(super) fn service_command(&self) -> Command {
        let mut command = self.command();
        if self.app_supervisor {
            command
                .env("BUTLER_APP_FOREGROUND_LEASE", "1")
                .env("BUTLER_APP_BUNDLED_SUPERVISOR", "1")
                .stdin(Stdio::piped());
        } else {
            command.stdin(Stdio::null());
        }
        command
    }
}

impl Agent {
    /// Remembers the instance-record nonce of the child just started, as the
    /// App does once the record shows its child's PID.
    pub(super) fn remember_instance(&mut self) {
        let Some(pid) = self.pid() else {
            return;
        };
        let record = self
            .launch
            .data
            .join("state/butler-agent-native-service.json");
        self.instance_nonce = read_json(&record)
            .filter(|record| record["pid"] == pid)
            .and_then(|record| record["nonce"].as_str().map(str::to_owned));
    }

    /// Releases the App's foreground lease as the App does when it quits:
    /// closes the write end of the child's stdin. False when no leased child
    /// runs.
    pub fn release_foreground_lease(&mut self) -> bool {
        self.child
            .as_mut()
            .and_then(|child| child.stdin.take())
            .map(drop)
            .is_some()
    }

    /// The App's exit handling for the child `pid`, run as soon as the exit is
    /// seen and before anything is awaited: true when the stop intent names
    /// that instance (both nonce and PID) and asks the App to start the
    /// replacement. Anything else is a stop or a crash.
    pub(super) fn app_restart_requested(&self, pid: u32) -> bool {
        if !self.launch.app_supervisor {
            return false;
        }
        let Some(nonce) = self.instance_nonce.as_deref() else {
            return false;
        };
        read_json(&self.launch.data.join("state/agent-stop-intent.json")).is_some_and(|intent| {
            intent["schema"] == STOP_INTENT_SCHEMA
                && intent["instance_id"] == nonce
                && intent["pid"] == pid
                && intent["reason"] == "restart"
                && intent["respawn_by"] == "app"
        })
    }
}

fn read_json(path: &Path) -> Option<Value> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}
