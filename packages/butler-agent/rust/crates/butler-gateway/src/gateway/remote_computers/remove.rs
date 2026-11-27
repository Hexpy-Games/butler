use super::{
    AppSetupPort, Computer, HttpError, Link, SessionStateRow, deploy, relay, session_state,
    session_state_path, ssh, ssh_key, ssh_password, store, target::SshTarget, transcripts,
};
use serde_json::Value;
use std::{path::Path, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

pub(super) async fn delete(
    setup: &Arc<dyn AppSetupPort>,
    data: &Path,
    computer: &Computer,
    version: &str,
    force: bool,
    cancel: CancellationToken,
) -> Result<Value, HttpError> {
    let reach = sessions(setup, data, computer, version, cancel.clone()).await;
    let reachable = match reach {
        Ok(sessions) => {
            if let Some(sessions) = sessions {
                if sessions.iter().any(SessionStateRow::has_active_turn) {
                    return Err(HttpError::public(
                        409,
                        "computer_busy",
                        "A conversation is still running on this computer.",
                    ));
                }
                let link = Link {
                    setup: setup.clone(),
                    root: data.to_path_buf(),
                    version: version.to_owned(),
                    cancel: cancel.clone(),
                    relays: None,
                };
                transcripts::final_pull(&link, computer)
                    .await
                    .map_err(|reason| {
                        butler_core::diagnostic!(
                            "[remote-transcripts] final pull failed computer={} reason={reason}",
                            computer.id
                        );
                        HttpError::public(
                            409,
                            "computer_not_synced",
                            "Couldn't bring back this computer's conversations. Try again.",
                        )
                    })?;
            }
            true
        }
        Err(_) if force => false,
        Err(_) => {
            return Err(HttpError::public(
                409,
                "computer_unreachable",
                "Couldn't reach Butler on this computer.",
            ));
        }
    };
    setup
        .save_computer_environment(computer.id.clone(), Default::default())
        .await?;
    let cleaned = reachable && deploy::remove(computer, cancel.clone()).await.is_ok();
    let mut result = serde_json::json!({"deleted": true, "remote_cleaned": cleaned});
    if computer.key_added {
        let key_removed =
            reachable && !force && remove_key(data, computer, cancel).await.unwrap_or(false);
        result["key_removed"] = key_removed.into();
    }
    store::delete(data.join("config/computers.json"), computer.id.clone()).await?;
    setup.delete_computer_key(computer.id.clone()).await?;
    if let Err(error) = tokio::fs::remove_file(session_state_path(data, &computer.id)).await
        && error.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(computer_id = %computer.id, %error, "Remote computer session state was not removed");
    }
    Ok(result)
}

async fn sessions(
    setup: &Arc<dyn AppSetupPort>,
    data: &Path,
    computer: &Computer,
    version: &str,
    cancel: CancellationToken,
) -> Result<Option<Vec<SessionStateRow>>, HttpError> {
    if !deploy::installed(computer, cancel.clone()).await? {
        return Ok(None);
    }
    deploy::ensure_running((data, version), computer, cancel.clone()).await?;
    let identity = setup.computer_key(computer.id.clone()).await?;
    relay::unlock(computer, &identity, cancel.clone()).await?;
    session_state::request(computer, cancel).await.map(Some)
}

async fn remove_key(
    data: &Path,
    computer: &Computer,
    cancel: CancellationToken,
) -> Result<bool, HttpError> {
    let shared = super::list(data).await?.iter().any(|other| {
        other.id != computer.id
            && other.managed_key
            && ((other.address == computer.address && other.port == computer.port)
                || other
                    .host_keys
                    .iter()
                    .any(|key| computer.host_keys.contains(key)))
    });
    if shared {
        return Ok(false);
    }
    let Some(public) = ssh_key::public_key().await? else {
        return Ok(false);
    };
    let target = SshTarget::of(computer).await?;
    let command = ssh_password::command(ssh_password::blob(&public)?);
    let output = ssh::run(
        target.arguments("yes", &[], &command)?,
        ssh::Stdin::Bytes(ssh_password::REMOVE.to_vec()),
        Duration::from_secs(30),
        cancel,
    )
    .await?;
    Ok(output.exit_code == Some(0))
}
