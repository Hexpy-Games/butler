use std::collections::HashSet;
use std::fs;

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::btcc::{
    BtccError, DurableWorkStatus as WorkStatus, ProjectWorkLocateInput,
    ProjectWorkOperationIdentity, ResolvedProjectWorkScope, WorkContext, WorkTurnScope, WorkView,
};

use super::super::{ProjectLedgerReadError, committed, records};
use super::codec::Snapshot;
use super::snapshot;
use super::{ProjectWorkRepository, invalid};

pub(super) struct Relation {
    pub head: Option<Snapshot>,
    pub binding: Option<Snapshot>,
}

impl ProjectWorkRepository {
    pub(super) fn assert_scope(&self, scope: &WorkTurnScope) -> Result<(), BtccError> {
        if scope.project_ref.as_deref() != Some(self.scope.app_project_id.as_str()) {
            return Err(invalid("project_work_scope_mismatch"));
        }
        Ok(())
    }

    pub(super) async fn relation(&self, scope: &WorkTurnScope) -> Result<Relation, BtccError> {
        self.assert_scope(scope)?;
        let located = self
            .shared
            .projection
            .locate_canonical_works(ProjectWorkLocateInput {
                scope: self.scope.clone(),
                session_id: Some(scope.session_id.clone()),
                turn_id: Some(scope.turn_id.clone()),
            })
            .await?;
        let hints = [located.session_head_work_id, located.binding_work_id]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        self.relation_from_ids(
            &scope.session_id,
            Some(&scope.turn_id),
            (!hints.is_empty()).then_some(hints),
        )
        .await
    }

    pub(super) async fn relation_from_ids(
        &self,
        session_id: &str,
        turn_id: Option<&str>,
        hints: Option<Vec<String>>,
    ) -> Result<Relation, BtccError> {
        for _attempt in 0..3 {
            let before = self.source_version(hints.clone()).await?;
            let ids = match &hints {
                Some(ids) => ids.clone(),
                None => self.ids_for_session(session_id).await?,
            };
            let mut works = Vec::new();
            for id in ids.into_iter().collect::<HashSet<_>>() {
                let current = self.require_current(&id).await?;
                if current.view.session_id == session_id {
                    works.push(current);
                }
            }
            let after = self.source_version(hints.clone()).await?;
            if before != after {
                continue;
            }
            let heads = works
                .iter()
                .filter(|work| {
                    work.manifest.get("sessionHead").and_then(Value::as_bool) == Some(true)
                })
                .count();
            if hints.is_some() && heads == 0 {
                return Box::pin(self.relation_from_ids(session_id, turn_id, None)).await;
            }
            if heads != usize::from(!works.is_empty()) {
                return Err(invalid("project_work_managed_record_invalid"));
            }
            let binding_count = works
                .iter()
                .filter(|work| turn_id.is_some_and(|turn| has_binding(work, turn)))
                .count();
            if binding_count > 1 {
                return Err(invalid("project_work_managed_record_invalid"));
            }
            let head = works
                .iter()
                .find(|work| {
                    work.manifest.get("sessionHead").and_then(Value::as_bool) == Some(true)
                })
                .cloned();
            let binding = works
                .iter()
                .find(|work| turn_id.is_some_and(|turn| has_binding(work, turn)))
                .cloned();
            return Ok(Relation { head, binding });
        }
        Err(invalid("project_work_snapshot_unstable"))
    }

    pub(super) async fn current_for_scope(
        &self,
        scope: &WorkTurnScope,
    ) -> Result<Option<Snapshot>, BtccError> {
        let relation = self.relation(scope).await?;
        Ok(relation
            .binding
            .or_else(|| relation.head.filter(|head| is_open(&head.view))))
    }

    pub(super) async fn require_bound(
        &self,
        scope: &WorkTurnScope,
        allow_completed: bool,
    ) -> Result<Snapshot, BtccError> {
        let relation = self.relation(scope).await?;
        let binding = relation
            .binding
            .ok_or_else(|| invalid("project_work_turn_binding_missing"))?;
        if relation
            .head
            .as_ref()
            .is_none_or(|head| head.view.work_id != binding.view.work_id)
            || !has_binding(&binding, &scope.turn_id)
        {
            return Err(invalid("project_work_turn_binding_stale"));
        }
        if !(is_open(&binding.view)
            || allow_completed && binding.view.status == WorkStatus::Completed)
        {
            return Err(invalid("project_work_not_open"));
        }
        Ok(binding)
    }

    pub(super) async fn bound_for_turn_impl(
        &self,
        turn_id: String,
    ) -> Result<Option<WorkView>, BtccError> {
        let located = self
            .shared
            .projection
            .locate_canonical_works(ProjectWorkLocateInput {
                scope: self.scope.clone(),
                session_id: None,
                turn_id: Some(turn_id.clone()),
            })
            .await?;
        let ids = match located.binding_work_id {
            Some(id) => vec![id],
            None => self.ids_for_turn(&turn_id).await?,
        };
        let mut candidate = None;
        for id in ids.into_iter().collect::<HashSet<_>>() {
            let snapshot = self.require_current(&id).await?;
            if has_binding(&snapshot, &turn_id) {
                if candidate.is_some() {
                    return Err(invalid("project_work_managed_record_invalid"));
                }
                candidate = Some(snapshot);
            }
        }
        let Some(candidate) = candidate else {
            return Ok(None);
        };
        let relation = self
            .relation_from_ids(
                &candidate.view.session_id,
                Some(&turn_id),
                Some(vec![candidate.view.work_id.clone()]),
            )
            .await?;
        if relation
            .binding
            .as_ref()
            .is_none_or(|item| item.view.work_id != candidate.view.work_id)
        {
            return Err(invalid("project_work_turn_binding_stale"));
        }
        Ok(Some(candidate.view))
    }

    pub(super) async fn load_context_impl(
        &self,
        scope: WorkTurnScope,
    ) -> Result<Option<WorkContext>, BtccError> {
        self.assert_scope(&scope)?;
        // Source replayMutation requires mutationCallId. WorkTurnScope has no
        // such field, so this typed loadContext call follows currentForScope.
        let Some(work) = self.current_for_scope(&scope).await?.map(|item| item.view) else {
            return Ok(None);
        };
        let original = self
            .shared
            .projection
            .load_original_request(WorkTurnScope {
                turn_id: work.origin.turn_id.clone(),
                session_id: work.session_id.clone(),
                project_ref: Some(self.scope.app_project_id.clone()),
            })
            .await?;
        if original.turn_id != work.origin.turn_id || original.message_id != work.origin.message_id
        {
            return Err(invalid("project_work_runtime_origin_mismatch"));
        }
        let facts = self
            .shared
            .projection
            .load_result_facts(work.work_id.clone())
            .await?;
        Ok(Some(WorkContext {
            work,
            original_request: original,
            result_facts: facts,
        }))
    }

    pub(super) async fn recorded_at(
        &self,
        identity: ProjectWorkOperationIdentity,
    ) -> Result<String, BtccError> {
        let value = self
            .shared
            .projection
            .operation_recorded_at(identity)
            .await?;
        if value.is_empty() || crate::js_date::parse_iso_millis(&value).is_none() {
            return Err(invalid("project_work_operation_time_invalid"));
        }
        Ok(value)
    }

    pub(super) async fn ids_for_session(&self, session_id: &str) -> Result<Vec<String>, BtccError> {
        self.locate_ids(Some(session_id.to_owned()), None).await
    }

    pub(super) async fn ids_for_turn(&self, turn_id: &str) -> Result<Vec<String>, BtccError> {
        self.locate_ids(None, Some(turn_id.to_owned())).await
    }

    async fn locate_ids(
        &self,
        session: Option<String>,
        turn: Option<String>,
    ) -> Result<Vec<String>, BtccError> {
        let scope = self.scope.clone();
        self.shared
            .ledger
            .run(move |_, _| locate_ids(&scope, session.as_deref(), turn.as_deref()))
            .await
            .map_err(snapshot::read_error)
    }

    pub(super) async fn source_version(
        &self,
        ids: Option<Vec<String>>,
    ) -> Result<String, BtccError> {
        let scope = self.scope.clone();
        self.shared
            .ledger
            .run(move |_, _| source_version(&scope, ids.as_deref()))
            .await
            .map_err(snapshot::read_error)
    }
}

pub(super) fn is_open(view: &WorkView) -> bool {
    matches!(view.status, WorkStatus::Open | WorkStatus::Blocked)
}

pub(super) fn has_binding(snapshot: &Snapshot, turn_id: &str) -> bool {
    snapshot
        .manifest
        .get("bindingRefs")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items
                .iter()
                .any(|item| item.get("turnId").and_then(Value::as_str) == Some(turn_id))
        })
}

fn work_paths(
    scope: &ResolvedProjectWorkScope,
    ids: Option<&[String]>,
) -> Result<Vec<String>, ProjectLedgerReadError> {
    let ids = if let Some(ids) = ids {
        ids.to_vec()
    } else {
        match fs::read_dir(scope.ledger_root.join("work")) {
            Ok(entries) => {
                let mut ids = Vec::new();
                for entry in entries {
                    let entry = entry.map_err(|_| {
                        ProjectLedgerReadError::RecordShow("project_ledger_record_io_error")
                    })?;
                    if entry
                        .file_type()
                        .map_err(|_| {
                            ProjectLedgerReadError::RecordShow("project_ledger_record_io_error")
                        })?
                        .is_dir()
                    {
                        ids.push(entry.file_name().to_string_lossy().into_owned());
                    }
                }
                ids
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(_) => {
                return Err(ProjectLedgerReadError::RecordShow(
                    "project_ledger_record_io_error",
                ));
            }
        }
    };
    let mut paths = ids
        .into_iter()
        .collect::<HashSet<_>>()
        .into_iter()
        .map(|id| format!("work/{id}/work.md"))
        .collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
}

fn locate_ids(
    scope: &ResolvedProjectWorkScope,
    session: Option<&str>,
    turn: Option<&str>,
) -> Result<Vec<String>, ProjectLedgerReadError> {
    let mut matches = Vec::new();
    for path in work_paths(scope, None)? {
        let Some(raw) = committed::read_selected(&scope.ledger_root, &path)? else {
            continue;
        };
        let Some(metadata) = records::frontmatter(&raw) else {
            continue;
        };
        if metadata.get("kind").and_then(Value::as_str) != Some("work") {
            continue;
        }
        let Some(id) = metadata.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<Value>(records::frontmatter_body_ref(&raw))
        else {
            continue;
        };
        if manifest.get("schema").and_then(Value::as_str) != Some("butler.btcc-project-work.v1") {
            continue;
        }
        let matches_session = session.is_some_and(|target| {
            manifest.get("sessionId").and_then(Value::as_str) == Some(target)
        });
        let matches_turn = turn.is_some_and(|target| {
            manifest
                .get("bindingRefs")
                .and_then(Value::as_array)
                .is_some_and(|items| {
                    items
                        .iter()
                        .any(|item| item.get("turnId").and_then(Value::as_str) == Some(target))
                })
        });
        if matches_session || matches_turn {
            matches.push(id.to_owned());
        }
    }
    Ok(matches)
}

fn source_version(
    scope: &ResolvedProjectWorkScope,
    ids: Option<&[String]>,
) -> Result<String, ProjectLedgerReadError> {
    let all_paths = work_paths(scope, None)?;
    let selected = work_paths(scope, ids)?;
    let records = selected.iter().map(|path| {
        Ok(serde_json::json!({"path": path, "raw": committed::read_selected(&scope.ledger_root, path)?}))
    }).collect::<Result<Vec<_>, ProjectLedgerReadError>>()?;
    let source = serde_json::json!([all_paths, records]);
    let bytes = crate::json::stringify(&source)
        .map_err(|_| ProjectLedgerReadError::RecordShow("project_work_managed_record_invalid"))?;
    Ok(format!("{:x}", Sha256::digest(bytes.as_bytes())))
}
