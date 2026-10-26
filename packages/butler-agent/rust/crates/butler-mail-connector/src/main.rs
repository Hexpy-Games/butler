#[tokio::main]
async fn main() {
    if let Err(code) = butler_mail_connector::run().await {
        // Only stable errors reach stderr. Server responses may echo credentials.
        eprintln!(
            "{}",
            if code == "mail_auth_failed" {
                code
            } else {
                "mail_connector_failed"
            }
        );
        std::process::exit(1);
    }
}
