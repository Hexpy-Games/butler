use super::super::{artifacts, output};
use super::{AdapterOutcome, CancellationToken, CommandEffectAdapter, Map, Value};
use butler_models::models::current_computer_environment as current_env;
use butler_turn::workspace::{GuidedAccess, GuidedCommandInput};

impl CommandEffectAdapter {
    pub(super) async fn run_mutation(
        &self,
        args: &Map<String, Value>,
        command: &str,
        signal: &CancellationToken,
    ) -> Result<AdapterOutcome, butler_turn::btcc::EffectFailure> {
        let data = self.butler_data.clone();
        let inventory = self.inventory.clone();
        let before = self
            .jobs
            .run(move || {
                let inventory = inventory
                    .unwrap_or_else(|| butler_platform::secure_fs::SecretInventory::cached(&data));
                artifacts::snapshot(&data, &inventory)
            })
            .await
            .map_err(|error| {
                butler_turn::btcc::EffectFailure::adapter(error.message()).with_source(error)
            })?;
        let started = std::time::SystemTime::now();
        let spooled = self
            .commands
            .submit_guided(self.mutation_input(args, command, signal))
            .map_err(|error| {
                butler_turn::btcc::EffectFailure::adapter(error.message()).with_source(error)
            })?
            .await
            .map_err(|source| {
                butler_turn::btcc::EffectFailure::adapter("Command completion was lost")
                    .with_source(source)
            })?
            .map_err(|error| {
                butler_turn::btcc::EffectFailure::adapter(error.message()).with_source(error)
            })?;
        let effect = if self.effect == "remote_observation" {
            "remote_observation"
        } else {
            "command_mutation"
        };
        let result = output::public_result(
            output::OutputResources {
                output: &self.output,
                jobs: &self.jobs,
            },
            spooled,
            output::OutputOrigin {
                inventory: self.inventory.clone(),
                args,
                workspace: &self.root_identity,
                data_root: &self.butler_data,
                started,
            },
            Some(before),
            Some(effect),
        )
        .await
        .map_err(|error| {
            butler_turn::btcc::EffectFailure::adapter(error.message()).with_source(error)
        })?;
        match self.mutation_access() {
            GuidedAccess::ProjectWrite => {
                project_write_result(&result).map(AdapterOutcome::Applied)
            }
            GuidedAccess::SecretReadsDenied => {
                secret_reads_result(&result).map(AdapterOutcome::Applied)
            }
            _ => Ok(AdapterOutcome::Applied(result)),
        }
    }

    fn mutation_input(
        &self,
        args: &Map<String, Value>,
        command: &str,
        signal: &CancellationToken,
    ) -> GuidedCommandInput {
        GuidedCommandInput {
            allowed_folders: self.allowed_folders.clone(),
            extra_write_roots: self.extra_write_roots.clone(),
            protected_roots: self.protected_roots.clone(),
            installation_root: self.installation_root.clone(),
            command: command.into(),
            cwd: Some(self.cwd.to_string_lossy().into_owned()),
            workspace_root: self.root_identity.clone(),
            butler_data: self.butler_data.clone(),
            timeout_ms: args.get("timeout_ms").and_then(Value::as_f64),
            access: self.mutation_access(),
            host_environment: (*self.host_environment).clone(),
            computer_environment: current_env(),
            abort: signal.clone(),
        }
    }

    fn mutation_access(&self) -> GuidedAccess {
        if self.project_write {
            GuidedAccess::ProjectWrite
        } else if self.deny_secret_reads
            && butler_platform::command_sandbox::secret_reads_deniable()
        {
            GuidedAccess::SecretReadsDenied
        } else {
            GuidedAccess::FullAccessContained
        }
    }
}

/// Labels the project-write sandbox and, when the command failed, tells the
/// model how to get the access the sandbox withheld (the user is asked).
fn project_write_result(
    result: &butler_core::json::JsonDocument,
) -> Result<butler_core::json::JsonDocument, butler_turn::btcc::EffectFailure> {
    labelled(result, |value| {
        value["sandbox"] = if value.get("sandbox_violation").is_some() {
            "project_write_contained_swept"
        } else {
            "project_write_contained"
        }
        .into();
        value["containment"] = butler_platform::command_sandbox::project_write_mechanism().into();
        if value["ok"] == false {
            value["next_action"] = butler_platform::command_sandbox::project_write_limits().into();
        }
    })
}

/// Labels the credential-read denial and, when the command failed, says
/// what it withheld and how to ask the user for it.
fn secret_reads_result(
    result: &butler_core::json::JsonDocument,
) -> Result<butler_core::json::JsonDocument, butler_turn::btcc::EffectFailure> {
    labelled(result, |value| {
        value["sandbox"] = "credential_reads_denied".into();
        if value["ok"] == false {
            value["next_action"] = butler_platform::command_sandbox::SECRET_READ_LIMITS.into();
        }
    })
}

fn labelled(
    result: &butler_core::json::JsonDocument,
    label: impl FnOnce(&mut Value),
) -> Result<butler_core::json::JsonDocument, butler_turn::btcc::EffectFailure> {
    let mut value: Value = serde_json::from_str(result.as_str()).map_err(|error| {
        butler_turn::btcc::EffectFailure::adapter("command_result_encoding_failed")
            .with_source(error)
    })?;
    label(&mut value);
    butler_core::json::JsonDocument::from_value(&value).map_err(|error| {
        butler_turn::btcc::EffectFailure::adapter("command_result_encoding_failed")
            .with_source(error)
    })
}
