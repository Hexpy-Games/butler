//! The `butler-agent` executable. All argument handling lives in
//! [`butler_agent::Command`]; this file only starts the async runtime.

#[tokio::main]
async fn main() -> std::process::ExitCode {
    butler_agent::main(std::env::args_os().skip(1).collect()).await
}
