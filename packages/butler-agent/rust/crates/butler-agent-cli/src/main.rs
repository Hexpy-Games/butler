//! The `butler-agent` executable. All argument handling lives in
//! [`butler_agent::Command`]; this file only starts the async runtime.
//! Bound asynchronous worker/allocator overhead on large-core hosts; SQLite
//! and other blocking work retain their separate bounded owners.

fn main() -> std::process::ExitCode {
    if let Err(error) = butler_platform::process_names::name_current() {
        eprintln!("process_name_unavailable: {error}");
        return std::process::ExitCode::FAILURE;
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(butler_platform::cpu::performance_cores().min(8))
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("async_runtime_unavailable: {error}");
            return std::process::ExitCode::FAILURE;
        }
    };
    runtime.block_on(async {
        let recovery = tokio::task::spawn_blocking(|| {
            let executable =
                butler_platform::process_names::current_exe().map_err(|e| e.to_string())?;
            butler_platform::app_update::recover(&executable)
        })
        .await;
        if !matches!(recovery, Ok(Ok(()))) {
            eprintln!("app_update_recovery_failed: {recovery:?}");
            return std::process::ExitCode::FAILURE;
        }
        butler_agent::main(
            std::env::args_os().skip(1).collect(),
            butler_agent::BuildInfo {
                version: env!("BUTLER_RELEASE_VERSION"),
                build_id: env!("BUTLER_BUILD_ID"),
                profile: env!("BUTLER_BUILD_PROFILE"),
            },
        )
        .await
    })
}
