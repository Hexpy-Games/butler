//! POSIX shells.

use std::collections::HashMap;

use super::Invocation;

pub(super) const POSIX: bool = true;

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
