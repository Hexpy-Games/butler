//! The only MXC SDK adapter. Raw JSON preserves allowDaclMutation=false.
use mxc_sdk::{__ffi, v1};
use serde_json::Value;
use std::io::{self, Read};

pub(super) fn probe(request: &Value) -> Result<Value, Box<dyn std::error::Error>> {
    let mut typed = v1::ContainerRequest::new(
        request
            .pointer("/process/commandLine")
            .and_then(Value::as_str)
            .ok_or("probe_failed")?,
    );
    typed.containment =
        v1::Containment::ProcessContainer(v1::configs::ProcessContainerConfig::default());
    typed.filesystem = Some(v1::FilesystemPolicy {
        readonly_paths: paths(request, "readonlyPaths")?,
        readwrite_paths: paths(request, "readwritePaths")?,
        denied_paths: paths(request, "deniedPaths")?,
        ..Default::default()
    });
    typed.network = Some(v1::NetworkPolicy {
        ingress: Some(v1::NetworkIngressPolicy {
            default: Some(v1::NetworkAction::Deny),
            host_loopback: Some(v1::NetworkAction::Deny),
        }),
        egress: Some(v1::NetworkEgressPolicy {
            default: Some(v1::NetworkAction::Deny),
            ..Default::default()
        }),
        ..Default::default()
    });
    typed.ui = Some(v1::UiPolicy {
        disable: false,
        ..Default::default()
    });
    typed.working_directory = request
        .pointer("/process/cwd")
        .and_then(Value::as_str)
        .map(str::to_owned);
    typed.timeout_ms = Some(10000);
    let facts = v1::probe(Some(&typed))?;
    Ok(serde_json::to_value(facts)?)
}

pub(super) struct RunOutcome {
    code: i32,
    timed_out: bool,
}
impl RunOutcome {
    pub(super) fn report(self) -> i32 {
        if self.timed_out {
            eprintln!("\n{}", crate::command_sandbox::EXECUTION_TIMEOUT_MARKER);
        }
        self.code
    }
}

pub(super) fn run(request: &Value) -> Result<RunOutcome, Box<dyn std::error::Error>> {
    let mut child = __ffi::spawn_container_json(&serde_json::to_string(request)?, false)?;
    drop(child.take_stdin());
    let out = child.take_stdout().map(|stream| relay(stream, false));
    let err = child.take_stderr().map(|stream| relay(stream, true));
    let result = child.wait();
    for thread in [out, err].into_iter().flatten() {
        if !matches!(thread.join(), Ok(Ok(()))) {
            eprintln!("sandbox output relay failed");
        }
    }
    match result {
        Ok(v1::WaitResult::Exited(code)) => Ok(RunOutcome {
            code,
            timed_out: false,
        }),
        Ok(v1::WaitResult::TimedOut) => Ok(RunOutcome {
            code: crate::command_sandbox::EXECUTION_TIMEOUT_EXIT,
            timed_out: true,
        }),
        Err(error) => {
            eprintln!("sandbox child wait failed: {error}");
            Ok(RunOutcome {
                code: 126,
                timed_out: false,
            })
        }
    }
}

fn relay(
    mut stream: Box<dyn Read + Send>,
    stderr: bool,
) -> std::thread::JoinHandle<io::Result<()>> {
    std::thread::spawn(move || {
        if stderr {
            io::copy(&mut stream, &mut io::stderr().lock())?;
        } else {
            io::copy(&mut stream, &mut io::stdout().lock())?;
        }
        Ok(())
    })
}

pub(super) fn child_probe(request: &Value, nonce: &str) -> Value {
    let result = __ffi::run_json(&request.to_string(), false);
    match result {
        Err(error) => error_report(&error, "mxc_spawn_failed"),
        Ok(output) => {
            let (reason, code) = match output.outcome {
                v1::WaitResult::Exited(code) => {
                    let reason = if code == 0 && output.stdout == format!("{nonce}\n").as_bytes() {
                        "partial"
                    } else {
                        crate::command_sandbox::mxc_policy::reason_code(code.cast_unsigned())
                    };
                    (reason, Some(code))
                }
                v1::WaitResult::TimedOut => ("child_timed_out", None),
            };
            serde_json::json!({"reason":reason,"childExitCode":code,
                "childNtstatus":code.filter(|n| *n < 0).map(|n| format!("0x{:08X}", n.cast_unsigned())),
                "stderr":String::from_utf8_lossy(&output.stderr),"mxcError":null})
        }
    }
}

pub(super) fn error_report(error: &v1::Error, fallback: &str) -> Value {
    let native = error.native_code.as_deref().unwrap_or_default();
    let reason = if native == "1314" || native.eq_ignore_ascii_case("0x80070522") {
        "privilege_not_held"
    } else if error.code == v1::ErrorCode::PolicyValidation {
        "mxc_policy_invalid"
    } else {
        fallback
    };
    serde_json::json!({"reason":reason,"childExitCode":null,"childNtstatus":null,"stderr":"",
        "mxcError":{"code":error.code.to_string(),"operation":error.operation,
        "nativeCode":error.native_code,"message":error.message}})
}

fn paths(request: &Value, field: &str) -> Result<Vec<String>, &'static str> {
    request
        .get("filesystem")
        .and_then(|v| v.get(field))
        .and_then(Value::as_array)
        .ok_or("probe_failed")?
        .iter()
        .map(|value| value.as_str().map(str::to_owned).ok_or("probe_failed"))
        .collect()
}
