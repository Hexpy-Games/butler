//! The `butler-agent` executable. Runtime and argument handling live in the host.

fn main() -> std::process::ExitCode {
    if let Err(error) = butler_platform::process_names::name_current() {
        eprintln!("process_name_unavailable: {error}");
        return std::process::ExitCode::FAILURE;
    }
    // Probe before the Tokio runtime: the one-time Linux helper launch is
    // blocking I/O, while admission on runtime workers uses only cached facts.
    let _ = butler_platform::command_sandbox::capabilities();
    butler_agent::run(
        std::env::args_os().skip(1).collect(),
        butler_agent::BuildInfo {
            version: env!("BUTLER_RELEASE_VERSION"),
            build_id: env!("BUTLER_BUILD_ID"),
            profile: env!("BUTLER_BUILD_PROFILE"),
        },
    )
}
