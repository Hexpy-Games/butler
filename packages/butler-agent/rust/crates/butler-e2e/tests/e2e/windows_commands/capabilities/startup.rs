//! Separate ordinary cold startup from first-time historical index creation.
use super::*;
use rusqlite::Connection;
use std::path::Path;

#[tokio::test]
async fn owner_scale_cold_startup_with_and_without_indexes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        std::env::var("BUTLER_E2E_OWNER_SCALE").as_deref() == Ok("1"),
        "requires owner-scale disk history"
    );
    let (mut s, chat, script, server) = setup(Access::FullAccess).await?;
    s.agent
        .launch
        .env
        .push(("BUTLER_E2E_STARTUP_TRACE".into(), "1".into()));
    let history = scale::prepare(&mut s, &chat).await?;
    let case = Case {
        tool: "read_file",
        args: json!({"requests":[{"path":"home/Downloads/보고서.txt"}]}),
        refused: false,
    };
    super::super::operation::observe_operation(&s, &chat, &script, &case, Access::FullAccess)
        .await?;
    for missing_indexes in [false, true] {
        s.agent.terminate().await?;
        if missing_indexes {
            Connection::open(crate::btcc_scale::path(&s.sandbox.data))?.execute_batch(
                "DROP INDEX idx_btcc_turns_authority_waiting; DROP INDEX idx_btcc_subsession_outbox_pending;"
            )?;
        }
        let data = s.sandbox.data.clone();
        let files = tokio::task::spawn_blocking(move || discard(&data))
            .await
            .map_err(|error| HarnessError(error.to_string()))??;
        let started = Instant::now();
        s.gw = s.agent.start_again().await?;
        eprintln!(
            "APPROVAL-STARTUP missing_indexes={missing_indexes} files={files} elapsed_us={}",
            started.elapsed().as_micros()
        );
        for line in s
            .agent
            .current_logs()
            .await?
            .lines()
            .filter(|line| line.contains("[native-startup]") || line.contains("[btcc-startup]"))
        {
            eprintln!("APPROVAL-STARTUP missing_indexes={missing_indexes} {line}");
        }
        crate::btcc_scale::assert_indexed(&s.sandbox.data)?;
        crate::btcc_scale::assert_complete(&s.sandbox.data)?;
        let messages = s.gw.messages(&chat).await?;
        assert!(
            messages
                .iter()
                .any(|message| message["role"] == "user" && message["text"] == provider::PROMPT)
        );
        assert!(
            messages
                .iter()
                .any(|message| message["role"] == "assistant" && message["status"] == "delivered")
        );
    }
    scale::assert_complete(&s, history).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}

fn discard(directory: &Path) -> Result<usize, HarnessError> {
    let mut count = 0;
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            count += discard(&entry.path())?;
        } else if entry.file_type()?.is_file() {
            butler_platform::secure_fs::sync_path(entry.path())?;
            let file = std::fs::File::open(entry.path())?;
            if let Some(result) = butler_platform::secure_fs::discard_cached_pages(&file) {
                result?;
                count += 1;
            }
        }
    }
    Ok(count)
}
