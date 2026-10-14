//! The only MXC SDK adapter. Raw JSON preserves allowDaclMutation=false.
use mxc_sdk::{__ffi, v1};
use serde_json::Value;
use std::io::{self, Read};

pub(super) fn probe(request: &Value) -> Result<Value, &'static str> {
    let mut typed = v1::ContainerRequest::new(
        request["process"]["commandLine"]
            .as_str()
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
    typed.ui = Some(v1::UiPolicy::default());
    typed.working_directory = request["process"]["cwd"].as_str().map(str::to_owned);
    typed.timeout_ms = Some(10000);
    let facts = v1::probe(Some(&typed)).map_err(|_| "mxc_api_missing")?;
    serde_json::to_value(facts).map_err(|_| "probe_failed")
}

pub(super) fn run(request: &Value) -> Result<i32, Box<dyn std::error::Error>> {
    let mut child = __ffi::spawn_container_json(&serde_json::to_string(request)?, false)?;
    drop(child.take_stdin());
    let stdout = child.take_stdout().ok_or("missing stdout")?;
    let stderr = child.take_stderr().ok_or("missing stderr")?;
    let out = relay(stdout, false);
    let err = relay(stderr, true);
    let result = child.wait();
    out.join().map_err(|_| "stdout relay panicked")??;
    err.join().map_err(|_| "stderr relay panicked")??;
    match result? {
        v1::WaitResult::Exited(code) => Ok(code),
        v1::WaitResult::TimedOut => Err("container_timeout".into()),
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

pub(super) fn child_probe(
    request: &Value,
    nonce: &str,
) -> Result<&'static str, Box<dyn std::error::Error>> {
    let mut child = match __ffi::spawn_container_json(&serde_json::to_string(request)?, false) {
        Ok(child) => child,
        Err(error) => {
            let text = error.native_code.as_deref().unwrap_or_default();
            return Ok(
                if text.contains("1314") || text.eq_ignore_ascii_case("0x80070522") {
                    "privilege_not_held"
                } else if text.to_ascii_uppercase().contains("C0000142")
                    || text.contains("3221225794")
                {
                    "non_interactive_desktop"
                } else {
                    "probe_failed"
                },
            );
        }
    };
    drop(child.take_stdin());
    let stdout = child.take_stdout().ok_or("missing probe stdout")?;
    let out = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(256).read_to_end(&mut bytes).map(|_| bytes)
    });
    let status = child.wait()?;
    let bytes = out.join().map_err(|_| "probe relay panicked")??;
    Ok(match status {
        v1::WaitResult::Exited(0) if bytes == format!("{nonce}\n").as_bytes() => "partial",
        v1::WaitResult::Exited(code) => {
            crate::command_sandbox::mxc_policy::reason_code(code as u32)
        }
        _ => "probe_failed",
    })
}

fn paths(request: &Value, field: &str) -> Result<Vec<String>, &'static str> {
    request["filesystem"][field]
        .as_array()
        .ok_or("probe_failed")?
        .iter()
        .map(|value| value.as_str().map(str::to_owned).ok_or("probe_failed"))
        .collect()
}
