//! Read-only standalone installation, DATA, and owned-process health report.

use std::{ffi::OsString, process::ExitCode};

use serde_json::json;

mod checks;
use checks::{
    Check, check_value, data_check, digest_check, executable_check, owned_service_check,
    resources_check, version_check,
};

use super::{ResolvedInstallation, service_instance, settings_cli};

const CHECKS: [&str; 6] = [
    "executable",
    "resources",
    "version",
    "integrity",
    "data",
    "owned_service",
];

#[derive(Debug, Default)]
struct Options {
    data: Option<std::path::PathBuf>,
    check: Option<String>,
    json: bool,
    quiet: bool,
    positionals: Vec<String>,
}

pub fn recognizes(args: &[OsString]) -> bool {
    let mut index = 0;
    while index < args.len() {
        match args[index].to_string_lossy().as_ref() {
            "--data" | "--check" | "--home" => index += 2,
            "--fix" | "--collect-logs" | "--github" => index += 1,
            "--json" | "--verbose" | "--quiet" | "--silent" | "--yes" | "--non-interactive" => {
                index += 1
            }
            value if value.starts_with('-') => return false,
            value => return value == "doctor",
        }
    }
    false
}

pub async fn run(installation: ResolvedInstallation, args: Vec<OsString>) -> ExitCode {
    let json_requested = args.iter().any(|arg| arg == "--json");
    let options = match parse(&args) {
        Ok(options) => options,
        Err((code, message)) => return report_error(json_requested, code, &message, 2),
    };
    let data = match settings_cli::resolve_data_root_override(options.data.clone(), &installation) {
        Ok(data) => data,
        Err(error) => return report_error(options.json, "unsafe_path", &error, 1),
    };
    let mut checks = Vec::new();
    let requested = options.check.as_deref();
    if selected(requested, "executable")
        || requested == Some("payload")
        || requested == Some("installation")
    {
        checks.push(executable_check(&installation));
    }
    if selected(requested, "resources")
        || requested == Some("payload")
        || requested == Some("installation")
    {
        checks.push(resources_check(&installation));
    }
    if selected(requested, "version")
        || requested == Some("payload")
        || requested == Some("installation")
    {
        checks.push(version_check(&installation));
    }
    if selected(requested, "integrity")
        || requested == Some("payload")
        || requested == Some("installation")
    {
        checks.push(digest_check(&installation));
    }
    if selected(requested, "data") {
        checks.push(data_check(&data));
    }
    if selected(requested, "owned_service") || requested == Some("service") {
        checks.push(owned_service_check(&data, &installation));
    }
    let healthy = checks.iter().all(|check| check.status == "pass");
    let report = json!({
        "schema": "butler.native-doctor.v1",
        "status": if healthy { "healthy" } else { "degraded" },
        "exitCode": if healthy { 0 } else { 1 },
        "checks": checks.iter().map(check_value).collect::<Vec<_>>(),
        "capabilities": {
            "nativeExecutable": capability(&checks, "executable"),
            "installationResources": capability(&checks, "resources"),
            "installationIntegrity": capability(&checks, "integrity"),
            "ownedServiceIdentity": capability(&checks, "owned_service"),
            "repairs": false,
            "rawTextIncluded": false
        },
        "rawTextIncluded": false
    });
    if options.json {
        println!(
            "{}",
            json!({
                "ok": healthy,
                "command": "butler doctor",
                "data": report,
                "error": null,
                "privacy": {"rawTextIncluded": false, "secretsIncluded": false}
            })
        );
    } else if !options.quiet {
        println!(
            "Butler doctor: {}",
            report["status"].as_str().unwrap_or("degraded")
        );
        for check in &checks {
            println!(
                "[{}] {}: {}",
                check.status.to_uppercase(),
                check.id,
                check.summary
            );
        }
        println!("Repairs: unsupported (doctor is read-only)");
    }
    if healthy {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

fn parse(args: &[OsString]) -> Result<Options, (&'static str, String)> {
    let mut options = Options::default();
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        match value.as_ref() {
            "--data" => {
                let path = args
                    .get(index + 1)
                    .filter(|arg| !arg.is_empty() && !arg.to_string_lossy().starts_with('-'))
                    .ok_or(("invalid_arguments", "--data requires a path".into()))?;
                options.data = Some(path.into());
                index += 2;
                continue;
            }
            "--check" => {
                if options.check.is_some() {
                    return Err(("invalid_arguments", "--check may be supplied once".into()));
                }
                let check = args
                    .get(index + 1)
                    .map(|arg| arg.to_string_lossy().into_owned())
                    .filter(|value| !value.is_empty() && !value.starts_with('-'))
                    .ok_or(("invalid_arguments", "--check requires a name".into()))?;
                if !matches!(check.as_str(), "payload" | "installation" | "service")
                    && !CHECKS.contains(&check.as_str())
                {
                    return Err(("invalid_arguments", "unsupported doctor check".into()));
                }
                options.check = Some(check);
                index += 2;
                continue;
            }
            "--json" => options.json = true,
            "--quiet" | "--silent" => options.quiet = true,
            "--verbose" | "--yes" | "--non-interactive" => {}
            "--home" => {
                return Err((
                    "unsupported_logical_operation",
                    "--home is unsupported; use --data".into(),
                ));
            }
            "--fix" | "--collect-logs" | "--github" => {
                return Err((
                    "unsupported_logical_operation",
                    "doctor is read-only and does not perform repairs or external uploads".into(),
                ));
            }
            flag if flag.starts_with('-') => {
                return Err(("invalid_arguments", "unknown doctor option".into()));
            }
            _ => options.positionals.push(value.into_owned()),
        }
        index += 1;
    }
    if options.positionals.as_slice() != ["doctor"] {
        return Err(("invalid_arguments", "supported command: doctor".into()));
    }
    Ok(options)
}

fn selected(requested: Option<&str>, id: &str) -> bool {
    requested.is_none() || requested == Some(id)
}

fn capability(checks: &[Check], id: &str) -> Option<bool> {
    checks
        .iter()
        .find(|check| check.id == id)
        .map(|check| check.status == "pass")
}

fn report_error(json_output: bool, code: &str, message: &str, exit: u8) -> ExitCode {
    if json_output {
        println!(
            "{}",
            json!({
                "ok": false,
                "command": "butler doctor",
                "data": null,
                "error": {"code": code, "message": message},
                "privacy": {"rawTextIncluded": false, "secretsIncluded": false}
            })
        );
    } else {
        eprintln!("{code}: {message}");
    }
    ExitCode::from(exit)
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::{parse, recognizes};

    #[test]
    fn doctor_recognizer_skips_data_and_repair_flags_route_to_rejection() {
        let args = ["--data", "/tmp/butler-data", "doctor", "--fix"].map(OsString::from);
        assert!(recognizes(&args));
        assert_eq!(parse(&args).unwrap_err().0, "unsupported_logical_operation");
    }

    #[test]
    fn doctor_check_filter_is_explicit_and_home_is_rejected() {
        let args = ["doctor", "--check", "owned_service"].map(OsString::from);
        assert_eq!(
            parse(&args).unwrap().check.as_deref(),
            Some("owned_service")
        );
        let args = ["doctor", "--home", "/source"].map(OsString::from);
        assert_eq!(parse(&args).unwrap_err().0, "unsupported_logical_operation");
    }
}
