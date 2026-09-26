use std::{path::Path, process::ExitCode};

use serde_json::{Value, json};

use super::{Options, report_success};
use crate::host::service_instance;

pub(super) fn run(options: &Options, data_root: &Path) -> ExitCode {
    let record = service_instance::read_record(data_root);
    let locked = service_instance::instance_is_locked(data_root);
    let (status, pid, started_at, start_identity, executable, readiness, lock_held) =
        match (record, locked) {
            (Err(_), _) | (_, Err(_)) => (
                "stale",
                Value::Null,
                Value::Null,
                Value::Null,
                Value::Null,
                json!({ "state": "unknown", "readyAt": null }),
                Value::Null,
            ),
            (Ok(None), Ok(false)) => (
                "offline",
                Value::Null,
                Value::Null,
                Value::Null,
                Value::Null,
                json!({ "state": "offline", "readyAt": null }),
                Value::Bool(false),
            ),
            (Ok(None), Ok(true)) => (
                "stale",
                Value::Null,
                Value::Null,
                Value::Null,
                Value::Null,
                json!({ "state": "unknown", "readyAt": null }),
                Value::Bool(true),
            ),
            (Ok(Some(record)), Ok(locked)) => {
                let identity_matches = service_instance::process_matches(&record).unwrap_or(false);
                let executable_matches = std::env::current_exe()
                    .ok()
                    .and_then(|path| path.canonicalize().ok())
                    .is_some_and(|current| {
                        Path::new(&record.executable)
                            .canonicalize()
                            .is_ok_and(|recorded| recorded == current)
                    });
                let ready = record.state == "ready" && record.ready_at.is_some();
                let status = if locked && identity_matches && executable_matches && ready {
                    "online"
                } else {
                    "stale"
                };
                (
                    status,
                    json!(record.pid),
                    record
                        .ready_at
                        .as_ref()
                        .map_or(Value::Null, |value| json!(value)),
                    json!(record.process_start),
                    json!(record.executable),
                    json!({ "state": record.state, "readyAt": record.ready_at }),
                    json!(locked),
                )
            }
        };
    let data = json!({
        "source": "native-supervisor",
        "services": [{
            "name": "butler-agent-native",
            "pid": pid,
            "status": status,
            "supervisor": "native-service-lifecycle",
            "startedAt": started_at,
            "restartPolicy": "manual",
            "stdoutFile": data_root.join("logs/butler-agent-service.stdout.log"),
            "stderrFile": data_root.join("logs/butler-agent-service.stderr.log"),
            "lockHeld": lock_held,
            "processStartIdentity": start_identity,
            "executable": executable,
            "readiness": readiness,
        }],
    });
    let service = &data["services"][0];
    let human = format!(
        "{}: {} pid={}",
        service["name"].as_str().unwrap_or("butler-agent-native"),
        status,
        service["pid"]
            .as_u64()
            .map_or_else(|| "none".into(), |pid| pid.to_string())
    );
    report_success(options, "butler ps", data, &human);
    ExitCode::SUCCESS
}
