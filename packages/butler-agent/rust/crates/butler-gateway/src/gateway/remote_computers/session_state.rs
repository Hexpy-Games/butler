use super::{HttpError, Link, live_records, locked, relay};
use butler_core::configuration::{read_json_object, write_json_atomic};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::LazyLock,
};

static REFRESHES: LazyLock<Mutex<HashMap<String, bool>>> = LazyLock::new(Mutex::default);

#[derive(Deserialize, Serialize)]
pub(in crate::gateway) struct SessionStateRow {
    pub session_id: String,
    pub active_turn_state: Option<String>,
    pub attention_required: bool,
}

#[derive(Deserialize, Serialize)]
pub(in crate::gateway) struct SessionStateCache {
    pub version: u64,
    pub sessions: BTreeMap<String, SessionState>,
}

#[derive(Deserialize, Serialize)]
pub(in crate::gateway) struct SessionState {
    pub active_turn_state: Option<String>,
    pub attention_required: bool,
}

pub(in crate::gateway) fn session_state_path(root: &Path, computer_id: &str) -> PathBuf {
    root.join("config/computers")
        .join(format!("{computer_id}.sessions.json"))
}

pub(super) fn spawn_refresh(link: Link, computer_id: String) {
    {
        let mut refreshes = REFRESHES.lock();
        if let Some(rerun) = refreshes.get_mut(&computer_id) {
            *rerun = true;
            return;
        }
        refreshes.insert(computer_id.clone(), false);
    }
    tokio::spawn(async move {
        loop {
            match refresh(&link, &computer_id).await {
                Ok(true) => {
                    if let Some(relays) = &link.relays {
                        relays.emit(live_records::reconcile(&computer_id));
                    }
                }
                Ok(false) => {}
                Err(_) => butler_core::diagnostic!(
                    "[remote-session-state] refresh failed computer={computer_id}"
                ),
            }
            let mut refreshes = REFRESHES.lock();
            if refreshes.get_mut(&computer_id).is_some_and(std::mem::take) {
                continue;
            }
            refreshes.remove(&computer_id);
            return;
        }
    });
}

#[derive(Deserialize)]
struct StateReply {
    sessions: Vec<SessionStateRow>,
}

async fn refresh(link: &Link, computer_id: &str) -> Result<bool, HttpError> {
    let (_guard, computer) = locked(&link.root, computer_id).await?;
    let reply = relay::request(
        &computer,
        "GET",
        "/remote/sessions/state",
        Vec::new(),
        link.cancel.clone(),
    )
    .await?;
    let StateReply { sessions } =
        serde_json::from_value(relay::data(reply)?).map_err(|_| HttpError::Internal)?;
    let cache = SessionStateCache {
        version: 1,
        sessions: sessions
            .into_iter()
            .map(|row| {
                (
                    row.session_id,
                    SessionState {
                        active_turn_state: row.active_turn_state,
                        attention_required: row.attention_required,
                    },
                )
            })
            .collect(),
    };
    let path = session_state_path(&link.root, computer_id);
    tokio::task::spawn_blocking(move || {
        let next = serde_json::to_value(cache).map_err(|_| HttpError::Internal)?;
        if read_json_object(&path).is_ok_and(|previous| previous == next) {
            return Ok(false);
        }
        write_json_atomic(&path, &next).map_err(|_| HttpError::Internal)?;
        Ok(true)
    })
    .await
    .map_err(|_| HttpError::Internal)?
}
