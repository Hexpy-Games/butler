//! Fail-closed MXC 1.0.0 policy construction, with physical-path grants.
use super::{WinPath, command_line::command_line, environment, toolchain::Toolchain};
use crate::command_sandbox::Invocation;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// Inputs collected off async workers before running a contained command.
pub struct Plan {
    /// Physical admitted project root.
    pub project: WinPath,
    /// Physical Butler data root.
    pub data: WinPath,
    /// Sanitized host environment, before profile redirection.
    pub host_environment: BTreeMap<String, String>,
    /// Vetted toolchain grants and search paths.
    pub tools: Toolchain,
    /// Shared pre-run inventory, including every nested .git and secret entry.
    pub secrets: Vec<WinPath>,
    /// Existing credential roots, resolved by host discovery before redirection.
    pub credentials: Vec<WinPath>,
}
impl Plan {
    /// The only writable exceptions below the Butler data root.
    pub fn scratch(&self) -> Result<Vec<WinPath>, &'static str> {
        [
            "tmp\\project-write",
            "cache\\project-write",
            "artifacts\\generated",
        ]
        .iter()
        .map(|name| self.data.join(name))
        .collect()
    }
    /// Builds a request; command cwd is the helper-owned subst root.
    pub fn build(
        &self,
        invocation: &Invocation,
        drive: char,
        timeout_ms: u32,
        command_scratch: &WinPath,
    ) -> Result<Value, &'static str> {
        if !('D'..='Z').contains(&drive.to_ascii_uppercase()) {
            return Err("invalid project drive");
        }
        // Short commands retain the timer coercion used by the command owner.
        let timeout = timeout_ms.saturating_sub(500).max(1);
        let mut scratch = self.scratch()?;
        let temporary = scratch.first_mut().ok_or("scratch root missing")?;
        if command_scratch == temporary || !command_scratch.is_within(temporary) {
            return Err("invalid command scratch");
        }
        *temporary = command_scratch.clone();
        let cwd = WinPath::new(&format!("{drive}:\\"))?;
        let env = environment::build(
            &self.host_environment,
            scratch.first().ok_or("scratch root missing")?,
            &self.tools,
            &cwd,
        )?;
        let system = WinPath::new(
            environment::get(&self.host_environment, "SYSTEMROOT").ok_or("SYSTEMROOT required")?,
        )?;
        let mut write = vec![self.project.clone()];
        write.extend(scratch.clone());
        let mut read = self.tools.readonly.clone();
        read.push(system);
        read.push(self.project.join(".git")?);
        let mut deny = self.credentials.clone();
        deny.extend(self.tools.denied.clone());
        deny.push(self.project.join(".project-ledger")?);
        for secret in &self.secrets {
            if !secret.is_within(&self.project) {
                return Err("secret outside project");
            }
            if secret.as_str().rsplit('\\').next() == Some(".git") {
                read.push(secret.clone());
            } else {
                deny.push(secret.clone());
            }
        }
        self.validate(&write, &read, &deny, &scratch)?;
        let env: Vec<_> = env
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect();
        Ok(json!({
            "version":"1.0.0", "containment":"processcontainer",
            "fallback":{"allowDaclMutation":false},
            "lifecycle":{"destroyOnExit":true,"preservePolicy":false},
            "telemetry":{"enabled":false}, "ui":{"disable":false,"clipboard":"none","injection":false},
            "network":{"ingress":{"default":"deny","hostLoopback":"deny"},"egress":{"default":"deny"}},
            "process":{"commandLine":command_line(invocation)?,"cwd":cwd,"env":env,"inheritDefaultEnv":false,"timeout":timeout},
            "filesystem":{"readwritePaths":write,"readonlyPaths":read,"deniedPaths":deny}
        }))
    }
    fn validate(
        &self,
        write: &[WinPath],
        read: &[WinPath],
        denied: &[WinPath],
        scratch: &[WinPath],
    ) -> Result<(), &'static str> {
        let mut protected = vec![self.data.clone()];
        for key in ["USERPROFILE", "APPDATA", "LOCALAPPDATA"] {
            protected.push(WinPath::new(
                environment::get(&self.host_environment, key)
                    .ok_or("profile environment required")?,
            )?);
        }
        for grant in write.iter().chain(read) {
            if grant.is_drive_root() {
                return Err("drive root grant");
            }
            if protected.iter().any(|root| root.is_within(grant)) {
                return Err("profile or data root grant");
            }
            if grant.is_within(&self.data) && !scratch.contains(grant) {
                return Err("non-scratch data grant");
            }
            if denied.iter().any(|root| grant.is_within(root)) && !scratch.contains(grant) {
                return Err("grant below denied path");
            }
            // The design explicitly keeps CARGO_HOME read-only with literal
            // credential denials. That narrow exception never permits writes.
            if self.credentials.iter().any(|root| root.is_within(grant))
                && (write.contains(grant) || !self.readonly_cargo_home(grant)?)
            {
                return Err("credential ancestor grant");
            }
        }
        Ok(())
    }
    fn readonly_cargo_home(&self, grant: &WinPath) -> Result<bool, &'static str> {
        let cargo = if let Some(home) = environment::get(&self.host_environment, "CARGO_HOME") {
            WinPath::new(home)?
        } else {
            WinPath::new(
                environment::get(&self.host_environment, "USERPROFILE")
                    .ok_or("USERPROFILE required")?,
            )?
            .join(".cargo")?
        };
        Ok(grant == &cargo && self.tools.readonly.contains(grant))
    }
}
