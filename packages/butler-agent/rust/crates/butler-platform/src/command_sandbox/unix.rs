//! POSIX shells.

use std::collections::HashMap;

use super::Invocation;

pub(super) const ESCAPE: char = '\\';

pub(super) const POSIX: bool = true;

pub(super) fn working_directory(path: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    Ok(path.to_path_buf())
}

pub(super) fn add_arguments(command: &mut std::process::Command, invocation: &Invocation) {
    command.args(&invocation.arguments);
}

pub(super) fn login_shell(command: &str, _environment: &HashMap<String, String>) -> Invocation {
    Invocation {
        program: "/bin/sh".into(),
        arguments: vec!["-lc".into(), command.to_owned()],
    }
}

pub(super) fn legacy_shell(
    command: &str,
    pipefail: bool,
    _environment: &HashMap<String, Option<String>>,
) -> Invocation {
    let mut arguments = if pipefail {
        vec!["-o".into(), "pipefail".into()]
    } else {
        Vec::new()
    };
    arguments.extend(["-lc".into(), command.into()]);
    Invocation {
        program: "/bin/bash".into(),
        arguments,
    }
}

pub(super) fn is_registry_path(_path: &str) -> bool {
    false
}

pub(super) fn normalize_path_token(path: &str) -> String {
    path.to_owned()
}
