//! Lifecycle diagnostics contain identifiers and safe reason codes, never raw errors.

use crate::host::ResolvedInstallation;

pub(crate) fn version(installation: &ResolvedInstallation) -> String {
    format!(
        "{}+{}",
        installation
            .agent_version()
            .unwrap_or_else(|| crate::host::build_info::current().version.into()),
        crate::host::build_info::current().build_id
    )
}

pub(crate) fn lifecycle(version: &str, event: &str, code: &str, sentence: &str) {
    butler_core::diagnostic!(
        "[service-lifecycle] event={event} version={version} pid={} code={code} {sentence}",
        std::process::id()
    );
}

pub(crate) fn previous_exit(record: &super::instance::InstanceRecord) {
    butler_core::diagnostic!(
        "[service-lifecycle] event=exit version={} pid={} code=unclean_exit Previous service exited without a clean stop; detected at startup.",
        record
            .version
            .as_deref()
            .unwrap_or("unknown-previous-build"),
        record.pid
    );
}
