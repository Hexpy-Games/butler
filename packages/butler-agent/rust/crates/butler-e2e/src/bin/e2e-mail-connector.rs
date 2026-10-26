#[tokio::main]
async fn main() {
    std::process::exit(butler_mail_connector::run_process().await);
}
