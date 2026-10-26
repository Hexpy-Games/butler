#[tokio::main]
async fn main() {
    if butler_mail_connector::run().await.is_err() {
        // Only stable errors reach stderr. Server responses may echo credentials.
        eprintln!("mail_connector_failed");
        std::process::exit(1);
    }
}
