use super::{AppApplication, AppSessionSummary};
use crate::gateway::remote_computers::{self, SessionStateCache, session_state_path};
use std::collections::{HashMap, hash_map::Entry};

impl AppApplication {
    pub(super) async fn load_remote_sessions(&self, sessions: &mut [AppSessionSummary]) {
        if !sessions.iter().any(|session| session.computer_id.is_some()) {
            return;
        }
        let computers = remote_computers::list(&self.butler_data)
            .await
            .unwrap_or_default();
        let names: HashMap<_, _> = computers
            .iter()
            .map(|computer| (computer.id(), computer.name()))
            .collect();
        let mut cache = HashMap::new();
        for session in sessions {
            let Some(computer_id) = session.computer_id.as_deref() else {
                continue;
            };
            let name = names.get(computer_id);
            session.computer_name = name.map(|name| (*name).to_owned());
            let state = if name.is_some() {
                if let Entry::Vacant(entry) = cache.entry(computer_id) {
                    let path = session_state_path(&self.butler_data, computer_id);
                    let loaded = tokio::fs::read(path)
                        .await
                        .ok()
                        .and_then(|bytes| serde_json::from_slice::<SessionStateCache>(&bytes).ok())
                        .filter(|loaded| loaded.version == 1);
                    entry.insert(loaded);
                }
                cache
                    .get(computer_id)
                    .and_then(Option::as_ref)
                    .and_then(|loaded| loaded.sessions.get(&session.id))
            } else {
                None
            };
            session.active_turn_state = state.and_then(|state| state.active_turn_state.clone());
            session.attention_required = state.is_some_and(|state| state.attention_required);
            session.attention_source = session.attention_required.then_some("self");
        }
    }
}
