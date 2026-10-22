//! One-time observation through the same verified snapshot reader as normal
//! ProjectWork reads. No new manifest parser or Ledger publication is involved.
use super::{ProjectWork, ProjectWorkRepository, invalid};
use butler_turn::btcc::{BtccError, ProjectWorkObserveWorks, ResolvedProjectWorkScope};
use serde_json::{Value, json};
use std::collections::BTreeSet;

impl ProjectWork {
    /// Reads verified Ledger snapshots, passing each one through the startup
    /// observation port; returns source-linked diagnostics without fabrication.
    pub async fn observe_for_cutover<F, Fut>(
        &self,
        scope: ResolvedProjectWorkScope,
        sessions: BTreeSet<String>,
        observe: F,
    ) -> Result<Vec<Value>, BtccError>
    where
        F: Fn(ProjectWorkObserveWorks) -> Fut,
        Fut: std::future::Future<Output = Result<(), BtccError>>,
    {
        let root = scope.ledger_root.clone();
        let ids = self
            .shared
            .ledger
            .run(move |_, _| candidates(&root))
            .await
            .map_err(super::snapshot::read_error)?;
        let repository = ProjectWorkRepository {
            shared: self.shared.clone(),
            scope: scope.clone(),
        };
        let mut unresolved = Vec::new();
        for id in ids {
            if let Err(error) = observe_one(&repository, &id, &sessions, &observe).await {
                unresolved.push(json!({"source":"ledger_work","id":id,"code":error.code()}));
            }
        }
        Ok(unresolved)
    }
}

async fn observe_one<F, Fut>(
    repository: &ProjectWorkRepository,
    id: &str,
    sessions: &BTreeSet<String>,
    observe: &F,
) -> Result<(), BtccError>
where
    F: Fn(ProjectWorkObserveWorks) -> Fut,
    Fut: std::future::Future<Output = Result<(), BtccError>>,
{
    let snapshot = repository.require_current(id).await?;
    if !sessions.contains(&snapshot.view.session_id) {
        return Err(invalid("unresolvable_session"));
    }
    let version = repository.source_version(Some(vec![id.to_owned()])).await?;
    let work = super::publication::observed_work(snapshot)?;
    if work.work.session_id.is_empty() {
        return Err(invalid("project_work_session_missing"));
    }
    observe(ProjectWorkObserveWorks {
        session_head_work_id: work.work.work_id.clone(),
        works: vec![work],
        ledger_project_id: repository.scope.ledger_project_id.clone(),
        canonical_head_sha256: version,
        legacy_import_claim_work_id: None,
    })
    .await
}

fn candidates(root: &std::path::Path) -> Result<Vec<String>, super::super::ProjectLedgerReadError> {
    let failure = |e| {
        super::super::ProjectLedgerReadError::record_show("project_work_directory_unreadable")
            .with_source(e)
    };
    let entries = match std::fs::read_dir(root.join("work")) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(failure(e)),
    };
    let mut ids = Vec::new();
    for entry in entries {
        let entry = entry.map_err(failure)?;
        if entry.file_type().map_err(failure)?.is_dir() {
            ids.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    ids.sort();
    Ok(ids)
}
