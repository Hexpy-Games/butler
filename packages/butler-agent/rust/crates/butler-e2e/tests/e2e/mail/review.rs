use super::{direct::Direct, *};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

pub(super) fn id(mailbox: &str, validity: u32, uid: u32) -> String {
    format!("{}:{validity}:{uid}", URL_SAFE_NO_PAD.encode(mailbox))
}
pub(super) async fn arrived(direct: &Direct) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let batch = direct.read("connector://events").await?;
        if !batch["events"].as_array().unwrap().is_empty() {
            return Ok(batch);
        }
        assert!(Instant::now() < deadline, "pending mail did not arrive");
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

mod ack;
mod gmail;
mod headers;
mod ordinary;
mod reconnect;
mod relocation;
mod timeout;
mod unsubscribe;
