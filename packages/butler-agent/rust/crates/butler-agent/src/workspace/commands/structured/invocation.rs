use std::collections::HashMap;

use crate::workspace::CommandCode;
use crate::workspace::commands::{CommandError, CommandStep, StructuredCommandInput};

pub(super) fn invocation_steps(
    input: &StructuredCommandInput,
) -> Result<Vec<CommandStep>, CommandError> {
    let Some(legacy) = &input.legacy else {
        return Ok(input.steps.clone());
    };
    let command = crate::public_text::trim_js_whitespace(&legacy.command);
    if command.is_empty() {
        return Err(CommandError::new(
            CommandCode::LegacyCommandEmpty,
            "legacy command compatibility input is empty",
        ));
    }
    #[cfg(unix)]
    {
        let mut arguments = if legacy.pipefail {
            vec!["-o".into(), "pipefail".into()]
        } else {
            Vec::new()
        };
        arguments.extend(["-lc".into(), command.into()]);
        let step = CommandStep {
            executable: "/bin/bash".into(),
            arguments,
        };
        Ok(vec![protect_program_files(
            step,
            legacy.read_only_installation_root.as_deref(),
        )?])
    }
    #[cfg(not(unix))]
    {
        let executable = input
            .environment
            .get("BUTLER_POWERSHELL")
            .and_then(Option::as_deref)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("powershell.exe")
            .to_owned();
        Ok(vec![CommandStep {
            executable,
            arguments: vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-Command".into(),
                command.into(),
            ],
        }])
    }
}

pub(super) fn environment(input: &StructuredCommandInput) -> HashMap<String, String> {
    let mut env = if input.inherit_environment && input.legacy.is_none() {
        input.host_environment.clone()
    } else {
        HashMap::new()
    };
    for (key, value) in &input.environment {
        match value {
            Some(value) => {
                env.insert(key.clone(), value.clone());
            }
            None => {
                env.remove(key);
            }
        }
    }
    env
}

fn protect_program_files(
    step: CommandStep,
    home: Option<&std::path::Path>,
) -> Result<CommandStep, CommandError> {
    let Some(home) = home else {
        return Ok(step);
    };
    #[cfg(target_os = "macos")]
    {
        let lexical =
            crate::workspace::path_guard::lexical_absolute(home).map_err(CommandError::io)?;
        let real = lexical.canonicalize().unwrap_or_else(|_| lexical.clone());
        let mut roots = vec![lexical];
        if roots[0] != real {
            roots.push(real);
        }
        let mut clauses = Vec::with_capacity(roots.len());
        for root in roots {
            let quoted =
                serde_json::to_string(&root.to_string_lossy().as_ref()).map_err(|error| {
                    CommandError::new(CommandCode::CommandJsonFailed, error.to_string())
                        .with_source(error)
                })?;
            clauses.push(format!("(subpath {quoted})"));
        }
        let profile = format!(
            "(version 1)(allow default)(deny file-write* {})",
            clauses.join(" ")
        );
        let mut arguments = vec!["-p".into(), profile, step.executable];
        arguments.extend(step.arguments);
        Ok(CommandStep {
            executable: "/usr/bin/sandbox-exec".into(),
            arguments,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = home;
        Ok(step)
    }
}
