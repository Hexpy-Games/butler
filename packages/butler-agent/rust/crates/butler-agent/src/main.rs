//! The `butler-agent` executable. All argument handling lives in
//! [`butler_agent::Command`]; this file only starts the async runtime.

#[tokio::main]
async fn main() -> std::process::ExitCode {
    if let Err(error) = butler_platform::process_names::name_current() {
        eprintln!("process_name_unavailable: {error}");
        return std::process::ExitCode::FAILURE;
    }
    butler_agent::main(std::env::args_os().skip(1).collect()).await
}
