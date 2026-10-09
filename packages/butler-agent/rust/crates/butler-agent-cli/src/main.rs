//! The `butler-agent` executable. Runtime and argument handling live in the host.

fn main() -> std::process::ExitCode {
    if let Err(error) = butler_platform::process_names::name_current() {
        eprintln!("process_name_unavailable: {error}");
        return std::process::ExitCode::FAILURE;
    }
    butler_agent::run(
        std::env::args_os().skip(1).collect(),
        butler_agent::BuildInfo {
            version: env!("BUTLER_RELEASE_VERSION"),
            build_id: env!("BUTLER_BUILD_ID"),
            profile: env!("BUTLER_BUILD_PROFILE"),
        },
    )
}
