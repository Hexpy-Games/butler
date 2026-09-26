use std::cmp::Ordering;
use std::fs;

use serde_json::{Map, Value};

use crate::btcc::BtccError;
use crate::locale::LocaleCollation;
use crate::workspace::{
    OwnOptional, SessionBindingStore, SessionLifecycleState, SessionRole, StoredSessionBinding,
    UpsertSessionBinding,
};

use super::{NativeServiceBootstrap, NativeServiceConfiguration};

const DEFAULT_BUTLER_SESSION_ID: &str = "butler/main";

impl NativeServiceConfiguration {
    /// Called after the process store is open and before the first inbound Turn.
    pub(crate) async fn bootstrap_butler_session(
        &self,
        store: &SessionBindingStore,
        collation: &LocaleCollation,
    ) -> Result<NativeServiceBootstrap, BtccError> {
        let session_id = self.resolve_butler_session(store, collation).await?;
        let existing = store
            .get_by_session_id(&session_id)
            .await
            .map_err(BtccError::from)?;
        let (binding, newly_registered) = if let Some(existing) = existing.filter(|binding| {
            !matches!(
                binding.lifecycle_state,
                SessionLifecycleState::Closed | SessionLifecycleState::Crashed
            )
        }) {
            self.validate_workspace(std::path::Path::new(&existing.workspace_path))?;
            (self.reactivate(store, existing).await?, false)
        } else {
            (self.register(store, session_id).await?, true)
        };
        // The caller appends source's new-registration session_status event,
        // then calls persist_session_pointer before admitting any Turn.
        Ok(NativeServiceBootstrap {
            binding,
            newly_registered,
        })
    }

    async fn resolve_butler_session(
        &self,
        store: &SessionBindingStore,
        collation: &LocaleCollation,
    ) -> Result<String, BtccError> {
        if let Some(pointer) = self.read_session_pointer() {
            return Ok(pointer);
        }
        let mut sessions = store
            .list_sessions(Some(vec![
                SessionLifecycleState::Active,
                SessionLifecycleState::Closing,
            ]))
            .await
            .map_err(BtccError::from)?;
        sessions.retain(|session| session.role == SessionRole::Butler);
        // Stable sort preserves the store's updated_at/session_id order for a tie.
        sessions.sort_by(|left, right| {
            let left_time = left.last_active_at.as_deref().unwrap_or(&left.updated_at);
            let right_time = right.last_active_at.as_deref().unwrap_or(&right.updated_at);
            match collation.compare(right_time, left_time) {
                Ordering::Equal => Ordering::Equal,
                result => result,
            }
        });
        Ok(sessions
            .first()
            .map(|binding| binding.session_id.clone())
            .unwrap_or_else(|| DEFAULT_BUTLER_SESSION_ID.to_owned()))
    }

    async fn register(
        &self,
        store: &SessionBindingStore,
        session_id: String,
    ) -> Result<StoredSessionBinding, BtccError> {
        let workspace = expand_home(&self.data_root, &self.user_home);
        let project_id = self.project_id_for(&workspace);
        let mut metadata = Map::new();
        metadata.insert(
            "source".into(),
            Value::String("native-butler-bootstrap".into()),
        );
        store
            .upsert(UpsertSessionBinding {
                session_id,
                role: SessionRole::Butler,
                project_id,
                app_project_id: OwnOptional::Absent,
                ledger_project_id: OwnOptional::Absent,
                workspace_path: workspace,
                runtime_adapter_id: "btcc-turn-runtime".into(),
                model_provider_id: self.provider_id.clone(),
                model_ref: self.default_binding_model_ref.clone(),
                runtime_session_ref: None,
                provider_thread_ref: None,
                transport_bindings: Vec::new(),
                lifecycle_state: Some(SessionLifecycleState::Active),
                created_at: None,
                updated_at: None,
                last_active_at: None,
                metadata: Some(metadata),
            })
            .await
            .map_err(BtccError::from)
    }

    async fn reactivate(
        &self,
        store: &SessionBindingStore,
        existing: StoredSessionBinding,
    ) -> Result<StoredSessionBinding, BtccError> {
        let model_provider_id = existing
            .model_ref
            .split('/')
            .next()
            .map(crate::public_text::trim_js_whitespace)
            .filter(|value| !value.is_empty())
            .unwrap_or(&self.provider_id)
            .to_owned();
        store
            .upsert(UpsertSessionBinding {
                session_id: existing.session_id,
                role: existing.role,
                project_id: existing.project_id,
                app_project_id: match existing.app_project_id {
                    Some(value) => OwnOptional::Value(value),
                    None => OwnOptional::Null,
                },
                ledger_project_id: match existing.ledger_project_id {
                    Some(value) => OwnOptional::Value(value),
                    None => OwnOptional::Null,
                },
                workspace_path: existing.workspace_path,
                runtime_adapter_id: "btcc-turn-runtime".into(),
                model_provider_id,
                model_ref: existing.model_ref,
                runtime_session_ref: existing.runtime_session_ref,
                provider_thread_ref: existing.provider_thread_ref,
                transport_bindings: existing.transport_bindings,
                lifecycle_state: Some(SessionLifecycleState::Active),
                created_at: Some(existing.created_at),
                updated_at: None,
                last_active_at: None,
                metadata: existing.metadata,
            })
            .await
            .map_err(BtccError::from)
    }

    fn read_session_pointer(&self) -> Option<String> {
        let bytes = fs::read(self.pointer_path()).ok()?;
        let text = String::from_utf8_lossy(&bytes);
        let trimmed = crate::public_text::trim_js_whitespace(&text);
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    }

    pub(crate) fn persist_session_pointer(&self, session_id: &str) -> Result<(), BtccError> {
        let directory = self.data_root.join("config");
        fs::create_dir_all(&directory)
            .map_err(|error| io("butler_session_pointer_write_failed", &error))?;
        fs::write(self.pointer_path(), format!("{session_id}\n"))
            .map_err(|error| io("butler_session_pointer_write_failed", &error))
    }

    fn pointer_path(&self) -> std::path::PathBuf {
        self.data_root.join("config/session-id.txt")
    }

    fn project_id_for(&self, workspace: &str) -> Option<String> {
        self.projects.iter().find_map(|(path, name)| {
            (!name.is_empty()
                && expand_home(std::path::Path::new(path), &self.user_home) == workspace)
                .then(|| name.clone())
        })
    }
}

fn io(code: &'static str, error: &std::io::Error) -> BtccError {
    BtccError::new(code, error.to_string())
}

fn expand_home(path: &std::path::Path, home: &std::path::Path) -> String {
    let value = path.to_string_lossy();
    if value == "~" {
        home.to_string_lossy().into_owned()
    } else if let Some(tail) = value.strip_prefix("~/") {
        home.join(tail).to_string_lossy().into_owned()
    } else {
        value.into_owned()
    }
}
