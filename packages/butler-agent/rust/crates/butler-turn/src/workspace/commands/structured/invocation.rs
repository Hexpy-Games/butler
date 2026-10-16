use std::collections::HashMap;

use butler_platform::command_sandbox::{self, ProtectError, Protection};

use crate::workspace::CommandCode;
use crate::workspace::commands::{CommandError, CommandStep, StructuredCommandInput};
use crate::workspace::path_guard::lexical_absolute;

pub(super) fn invocation_steps(
    input: &StructuredCommandInput,
) -> Result<Vec<CommandStep>, CommandError> {
    let Some(legacy) = &input.legacy else {
        return Ok(input.steps.clone());
    };
    let command = butler_core::public_text::trim_js_whitespace(&legacy.command);
    if command.is_empty() {
        return Err(CommandError::new(
            CommandCode::LegacyCommandEmpty,
            "legacy command compatibility input is empty",
        ));
    }
    let shell = command_sandbox::legacy_shell(command, legacy.pipefail, &input.environment);
    let shell = match legacy.read_only_installation_root.as_deref() {
        Some(root) => {
            let root = lexical_absolute(root).map_err(CommandError::io)?;
            match command_sandbox::protect_writes(shell, &root).map_err(protect_failed)? {
                Protection::Enforced(protected) => protected,
                // Linux (until Landlock) and Windows run the program files
                // unprotected, as they always did.
                Protection::Unavailable(unprotected) => unprotected,
            }
        }
        None => shell,
    };
    Ok(vec![CommandStep {
        executable: shell.program,
        arguments: shell.arguments,
    }])
}

fn protect_failed(error: ProtectError) -> CommandError {
    match error {
        ProtectError::Profile(error) => {
            CommandError::new(CommandCode::CommandJsonFailed, error.to_string()).with_source(error)
        }
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
