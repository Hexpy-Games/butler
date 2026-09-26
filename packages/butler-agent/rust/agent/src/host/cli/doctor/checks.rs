//! Read-only individual installation, DATA, and owned-process checks.

use std::{fs, os::unix::fs::PermissionsExt, path::Path};

use serde_json::{Value, json};

use super::{ResolvedInstallation, service_instance};

mod integrity;
pub(super) use integrity::digest_check;

pub(super) struct Check {
    pub(super) id: &'static str,
    pub(super) status: &'static str,
    pub(super) summary: &'static str,
    pub(super) evidence: Value,
}

pub(super) fn executable_check(installation: &ResolvedInstallation) -> Check {
    let path = installation.executable();
    let passed = fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0);
    Check {
        id: "executable",
        status: if passed { "pass" } else { "fail" },
        summary: if passed {
            "native executable is present and executable"
        } else {
            "native executable is unavailable"
        },
        evidence: json!({"present": passed, "path": path}),
    }
}

pub(super) fn resources_check(installation: &ResolvedInstallation) -> Check {
    let path = installation.resources();
    let passed = fs::metadata(path).is_ok_and(|metadata| metadata.is_dir());
    Check {
        id: "resources",
        status: if passed { "pass" } else { "fail" },
        summary: if passed {
            "installation resources directory is present"
        } else {
            "installation resources directory is unavailable"
        },
        evidence: json!({"present": passed, "path": path}),
    }
}

pub(super) fn version_check(installation: &ResolvedInstallation) -> Check {
    let result = installation.native_payload_provenance();
    let passed = result.as_ref().is_ok_and(|value| {
        value
            .as_ref()
            .is_some_and(|manifest| manifest.agent_version.is_some())
    });
    let provenance = result.ok().flatten();
    Check {
        id: "version",
        status: if passed { "pass" } else { "fail" },
        summary: if passed {
            "version is read from the installed native manifest"
        } else {
            "installed native manifest version is unavailable or invalid"
        },
        evidence: json!({
            "schema": provenance.as_ref().map(|value| &value.schema),
            "agentVersion": provenance.as_ref().and_then(|value| value.agent_version.as_deref()),
            "appVersion": provenance.as_ref().and_then(|value| value.app_version.as_deref()),
            "platform": provenance.as_ref().and_then(|value| value.platform.as_deref()),
            "architecture": provenance.as_ref().and_then(|value| value.architecture.as_deref()),
            "binary": provenance.as_ref().and_then(|value| value.binary.as_deref()),
            "resources": provenance.as_ref().and_then(|value| value.resources.as_deref()),
            "launcher": provenance.as_ref().and_then(|value| value.launcher.as_deref()),
            "binarySha256": provenance.as_ref().and_then(|value| value.binary_sha256.as_deref()),
            "resourcesSha256": provenance.as_ref().and_then(|value| value.resources_sha256.as_deref())
        }),
    }
}

pub(super) fn data_check(data: &Path) -> Check {
    let passed = fs::symlink_metadata(data)
        .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink());
    Check {
        id: "data",
        status: if passed { "pass" } else { "warn" },
        summary: if passed {
            "DATA directory is present; doctor did not initialize it"
        } else {
            "DATA directory is absent; doctor did not initialize it"
        },
        evidence: json!({"present": passed, "path": data, "initialized": false}),
    }
}

pub(super) fn owned_service_check(data: &Path, installation: &ResolvedInstallation) -> Check {
    let state_dir = data.join("state");
    if fs::symlink_metadata(&state_dir)
        .is_ok_and(|metadata| metadata.file_type().is_symlink() || !metadata.is_dir())
    {
        return Check {
            id: "owned_service",
            status: "fail",
            summary: "owned service state path is aliased or not a directory",
            evidence: json!({"state": "ambiguous", "path": state_dir}),
        };
    }
    let record = service_instance::read_record(data);
    let lock = service_instance::instance_lock_is_held_read_only(data);
    let (status, summary, evidence) = match (record, lock) {
        (Err(_), _) | (_, Err(_)) => (
            "fail",
            "owned service identity could not be read safely",
            json!({"identity": "unavailable"}),
        ),
        (Ok(None), Ok(false)) => (
            "warn",
            "no native service instance is currently recorded",
            json!({"state": "offline", "lockHeld": false}),
        ),
        (Ok(None), Ok(true)) => (
            "fail",
            "instance lock is held without an ownership record",
            json!({"state": "ambiguous", "lockHeld": true}),
        ),
        (Ok(Some(record)), Ok(lock_held)) => {
            let identity_matches = service_instance::process_matches(&record).unwrap_or(false);
            let executable_matches = Path::new(&record.executable) == installation.executable();
            let ready = lock_held
                && identity_matches
                && executable_matches
                && record.state == "ready"
                && record.ready_at.is_some();
            let transitional = matches!(record.state.as_str(), "starting" | "stopping");
            let code = if ready {
                "pass"
            } else if transitional && lock_held && identity_matches {
                "warn"
            } else {
                "fail"
            };
            let summary = if ready {
                "record, kernel lock, PID birth identity, and executable agree"
            } else if transitional {
                "owned service is in a startup or shutdown transition"
            } else {
                "owned service record, process, executable, or kernel lock disagree"
            };
            (
                code,
                summary,
                json!({
                    "state": record.state,
                    "pid": record.pid,
                    "lockHeld": lock_held,
                    "processIdentityMatches": identity_matches,
                    "executableMatches": executable_matches,
                    "readyAt": record.ready_at,
                    "appEnabled": record.app_enabled,
                    "identityEvidence": "kernel_lock_pid_birth_and_executable"
                }),
            )
        }
    };
    Check {
        id: "owned_service",
        status,
        summary,
        evidence,
    }
}

pub(super) fn check_value(check: &Check) -> Value {
    json!({"id": check.id, "status": check.status, "summary": check.summary, "evidence": check.evidence})
}
