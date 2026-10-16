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

#[derive(Debug)]
pub(super) struct RunError(pub String);
impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for RunError {}

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
    let creation = super::timing::Phase::start("container_create");
    let mut child = __ffi::spawn_container_json(&serde_json::to_string(request)?, false)?;
    drop(creation);
    drop(child.take_stdin());
    let closers = [child.stdout_closer(), child.stderr_closer()];
    let stdout = child
        .take_stdout()
        .ok_or_else(|| RunError("sandbox stdout pipe missing".into()))?;
    let stderr = child
        .take_stderr()
        .ok_or_else(|| RunError("sandbox stderr pipe missing".into()))?;
    let out = relay(stdout, false);
    let err = relay(stderr, true);
    let wait = super::timing::Phase::start("child_wait");
    let result = child.wait();
    drop(wait);
    let _phase = super::timing::Phase::start("container_teardown");
    if result.is_err() {
        let _ = child.kill();
    }
    // Backends may retain pipe ends until their process object is dropped.
    // Release them before joining, as MXC's own wait_with_output does.
    drop(child);
    if !matches!(result, Ok(v1::WaitResult::Exited(_))) {
        for closer in closers.into_iter().flatten() {
            closer.close();
        }
    }
    finish_wait(result, [out, err]).map_err(Into::into)
}

fn finish_wait(
    result: io::Result<v1::WaitResult>,
    relays: [std::thread::JoinHandle<io::Result<()>>; 2],
) -> Result<RunOutcome, RunError> {
    let mut relay_error = None;
    for thread in relays {
        let status = thread
            .join()
            .map_err(|_| io::Error::other("relay panicked"))
            .and_then(|result| result);
        if let Err(error) = status {
            relay_error = Some(error);
        }
    }
    let result = result.map_err(|error| RunError(format!("sandbox child wait failed: {error}")))?;
    if let Some(error) = relay_error {
        return Err(RunError(format!("sandbox output incomplete: {error}")));
    }
    match result {
        v1::WaitResult::Exited(code) => Ok(RunOutcome {
            code,
            timed_out: false,
        }),
        v1::WaitResult::TimedOut => Ok(RunOutcome {
            code: crate::command_sandbox::EXECUTION_TIMEOUT_EXIT,
            timed_out: true,
        }),
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

#[cfg(feature = "test-support")]
pub(super) fn verify_output_failures() {
    struct FailedRead;
    impl Read for FailedRead {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("fixture read failure"))
        }
    }
    let complete = || std::thread::spawn(|| Ok(()));
    let failed = finish_wait(
        Err(io::Error::other("fixture wait failure")),
        [complete(), complete()],
    );
    assert!(failed.is_err_and(|error| error.to_string().contains("child wait failed")));
    let failed = finish_wait(
        Ok(v1::WaitResult::Exited(0)),
        [relay(Box::new(FailedRead), false), complete()],
    );
    assert!(failed.is_err_and(|error| error.to_string().contains("output incomplete")));
}
