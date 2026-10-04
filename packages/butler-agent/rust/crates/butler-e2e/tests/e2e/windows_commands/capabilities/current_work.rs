//! Sequential capabilities retain the current Work binding.
use super::{Access, Case, HarnessError, json, operation, setup};

#[tokio::test]
async fn sequential_file_capabilities_close_the_current_work() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, chat, script, server) = setup(Access::FullAccess).await?;
    for index in 0..8 {
        let name = format!("report-{index}.txt");
        let content = format!("complete current report {index}");
        std::fs::write(s.sandbox.home.join("Downloads").join(&name), &content)?;
        let case = Case {
            tool: "read_file",
            args: json!({"requests":[{"path":name}]}),
            refused: false,
        };
        let (output, _) = operation(&s, &chat, &script, &case, Access::FullAccess).await?;
        assert_eq!(output["files"][0]["content"], content);
        assert_eq!(output["files_read"], 1);
        assert_eq!(output["truncated"], false);
        let disposition = script.disposition.lock().unwrap().clone().unwrap();
        assert_eq!(
            disposition["ok"], true,
            "current Work disposition: {disposition}"
        );
        assert_eq!(disposition["work"]["status"], "completed");
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

