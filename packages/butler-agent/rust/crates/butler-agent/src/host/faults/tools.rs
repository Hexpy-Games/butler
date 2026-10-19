use butler_turn::btcc::{BtccError, ModelRoundToolCall, ToolExecutionError};

pub(in crate::host) async fn before_dispatch(
    data: &std::path::Path,
    call: &ModelRoundToolCall,
    turn_id: &str,
    session_id: &str,
) -> Result<(), ToolExecutionError> {
    hold_tool(data, call).await?;
    if std::env::var("BUTLER_E2E_INTERRUPT_TOOL").as_deref() == Ok(call.name.as_str())
        && tokio::fs::remove_file(data.join("e2e-interrupt-tool"))
            .await
            .is_ok()
    {
        butler_core::diagnostic!(
            "[native-tool] interrupted turn_id={} session_id={} capability={} code=e2e_tool_integrity_failure Injected tool integrity failure.",
            turn_id,
            session_id,
            call.name
        );
        return Err(integrity("e2e_tool_integrity_failure"));
    }
    Ok(())
}

async fn hold_tool(
    data: &std::path::Path,
    call: &ModelRoundToolCall,
) -> Result<(), ToolExecutionError> {
    if std::env::var("BUTLER_E2E_HOLD_TOOL").as_deref() != Ok(call.name.as_str()) {
        return Ok(());
    }
    let hold = data.join("e2e-hold-tool");
    if !tokio::fs::try_exists(&hold)
        .await
        .map_err(|_| integrity("e2e_tool_hold_failed"))?
    {
        return Ok(());
    }
    let marker = data.join("e2e-held-tool");
    let call_id = call.id.clone();
    // Existence is the waiter's signal, so publish only the complete tool ID.
    tokio::task::spawn_blocking(move || {
        butler_platform::secure_fs::replace_private(
            &marker,
            |file| std::io::Write::write_all(file, call_id.as_bytes()),
            std::convert::identity,
        )
    })
    .await
    .map_err(|_| integrity("e2e_tool_hold_failed"))?
    .map_err(|_| integrity("e2e_tool_hold_failed"))?;
    while tokio::fs::try_exists(&hold)
        .await
        .map_err(|_| integrity("e2e_tool_hold_failed"))?
    {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    Ok(())
}
fn integrity(code: &'static str) -> ToolExecutionError {
    ToolExecutionError::Integrity(BtccError::relayed(code, code))
}
