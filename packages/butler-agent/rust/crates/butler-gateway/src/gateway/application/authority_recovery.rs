//! Recover every durable authority decision independently at startup.
use super::{AppApplication, question_followup};

pub(super) async fn retry(app: &AppApplication) {
    // Failed authority retries remain durable for the next startup.
    match app.dependencies.authority_handoff.retry_decided().await {
        Ok(followups) => {
            for (owner, request_ref, input) in followups {
                let result = async {
                    let session = app.owner_chat(owner).await?;
                    question_followup::send(app, &session, &request_ref, &input).await
                }
                .await;
                if let Err(error) = result {
                    eprintln!(
                        "[authority-recovery] request={request_ref} followup failed: {error:?}"
                    );
                }
            }
        }
        Err(error) => {
            eprintln!("[authority-recovery] loading decided requests failed: {error:?}");
        }
    }
}
