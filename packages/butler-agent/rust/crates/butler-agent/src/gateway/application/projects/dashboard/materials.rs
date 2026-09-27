//! App-authored public materials and delivered-message artifact pages.

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::super::{AppApplication, GatewayApplicationError, app_error};
use super::artifacts::DashboardArtifact;
use super::artifacts::read_artifact;
use super::contracts::{
    AppProjectDashboardPageQuery, invalid_request, source_changed, unavailable,
};
use super::cursor::{self, RevisionOffsetCursor};
use super::project::{pins, read_project};
use super::session_links::ProjectSessionLinks;
use crate::public_text::sanitize_public_text;

pub(super) async fn get(
    application: &AppApplication,
    project_id: &str,
    query: AppProjectDashboardPageQuery,
) -> Result<Value, GatewayApplicationError> {
    if !(1..=100).contains(&query.limit) {
        return Err(invalid_request());
    }
    let project = read_project(application, project_id).await?;
    let Some(ledger_id) = project.ledger_project_id.clone() else {
        return Ok(unavailable("unbound"));
    };
    let Ok(snapshot) = application
        .dependencies
        .project_dashboard_ledger
        .snapshot(project.id.clone(), ledger_id)
        .await
    else {
        return Ok(unavailable("source_unavailable"));
    };
    let pin_rows = pins(&project).map_err(app_error)?;
    let mut pinned = Vec::new();
    for value in pin_rows {
        let Some(object) = value.as_object() else {
            continue;
        };
        let (Some(kind), Some(id), Some(revision)) = (
            object.get("kind").and_then(Value::as_str),
            object.get("id").and_then(Value::as_str),
            object.get("revision").and_then(Value::as_str),
        ) else {
            continue;
        };
        pinned.push((kind.to_owned(), id.to_owned(), revision.to_owned()));
    }
    let mut kinds: HashSet<&str> = if query.all {
        ["spec", "plan", "report", "work", "task", "artifact"]
            .into_iter()
            .collect()
    } else {
        ["spec", "plan", "report", "artifact"].into_iter().collect()
    };
    if !query.all {
        kinds.extend(pinned.iter().map(|(kind, _, _)| kind.as_str()));
    }
    let artifacts = read_pinned_artifacts(application, &project.id, &pinned).await?;
    let pin_order = pinned
        .iter()
        .enumerate()
        .map(|(index, (kind, id, _))| (format!("{kind}:{id}"), index))
        .collect::<HashMap<_, _>>();
    let sessions = application
        .list_sessions(Some("project".into()), Some(project.id.clone()))
        .await?;
    let key = project.id.clone();
    let links = application
        .storage
        .execute(move |db| ProjectSessionLinks::read(db, &key))
        .await
        .map_err(app_error)?;
    let overview = super::overview::facts(
        &snapshot.revision,
        &snapshot.observed_at,
        &snapshot.records,
        &snapshot.works,
        &sessions,
        &links,
    );
    let relevant_works = overview["remaining"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|work| work["id"].as_str())
        .map(str::to_owned)
        .collect::<HashSet<_>>();
    let mut related = HashSet::new();
    for work in &snapshot.works {
        if !relevant_works.contains(&work.record.id) {
            continue;
        }
        if work.record.spec.as_deref().is_some_and(|id| {
            snapshot.records.iter().any(|record| {
                record.id == id
                    && record.kind == "spec"
                    && matches!(record.status.as_str(), "active" | "approved")
            })
        }) {
            related.insert(format!(
                "spec:{}",
                work.record.spec.as_deref().unwrap_or_default()
            ));
        }
        if let Some(plan) = work
            .managed
            .as_ref()
            .and_then(|managed| managed.current_plan.as_ref())
        {
            related.insert(format!("plan:{}", plan.id));
        }
    }
    let mut sorted_records = snapshot.records.clone();
    sorted_records.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    let mut latest_reports = HashSet::new();
    for record in &sorted_records {
        if record.kind == "report"
            && record
                .parent_id
                .as_ref()
                .is_some_and(|parent| relevant_works.contains(parent))
            && latest_reports.insert(record.parent_id.clone().unwrap_or_default())
        {
            related.insert(format!("report:{}", record.id));
        }
        if matches!(record.kind.as_str(), "spec" | "plan")
            && record
                .parent_id
                .as_ref()
                .is_some_and(|parent| relevant_works.contains(parent))
            && matches!(
                record.status.as_str(),
                "active" | "approved" | "in_progress"
            )
        {
            related.insert(format!("{}:{}", record.kind, record.id));
        }
    }
    let current_plans = snapshot
        .works
        .iter()
        .filter_map(|work| {
            work.managed
                .as_ref()
                .and_then(|managed| managed.current_plan.as_ref())
                .map(|plan| (work.record.id.clone(), plan.id.clone()))
        })
        .collect::<HashMap<_, _>>();
    let mut rows = snapshot
        .records
        .iter()
        .filter(|record| {
            kinds.contains(record.kind.as_str())
                && (!query.important
                    || pin_order.contains_key(&format!("{}:{}", record.kind, record.id))
                    || related.contains(&format!("{}:{}", record.kind, record.id)))
                && !(record.kind == "plan"
                    && !pin_order.contains_key(&format!("plan:{}", record.id))
                    && current_plans
                        .get(record.parent_id.as_deref().unwrap_or_default())
                        .is_some_and(|current| current != &record.id))
        })
        .map(|record| MaterialRow {
            id: record.id.clone(),
            kind: record.kind.clone(),
            title: record.title.clone(),
            path: record.path.clone(),
            updated_at: record.updated_at.clone(),
            status: record.status.clone(),
            unavailable: record.unavailable,
            revision: snapshot.revision.clone(),
            artifact: None,
        })
        .collect::<Vec<_>>();
    rows.extend(artifacts.iter().map(|(id, artifact)| MaterialRow {
        id: id.clone(),
        kind: "artifact".into(),
        title: artifact.file.safe_name.clone(),
        path: artifact.file.safe_name.clone(),
        updated_at: artifact.file.created_at.clone(),
        status: "published".into(),
        unavailable: false,
        revision: artifact.revision.clone(),
        artifact: Some(artifact_json(artifact)),
    }));
    for (kind, id, revision) in &pinned {
        if !kinds.contains(kind.as_str())
            || artifacts.contains_key(id)
            || snapshot
                .records
                .iter()
                .any(|record| record.kind == *kind && record.id == *id)
        {
            continue;
        }
        rows.push(MaterialRow {
            id: id.clone(),
            kind: kind.clone(),
            title: String::new(),
            path: String::new(),
            updated_at: String::new(),
            status: "unavailable".into(),
            unavailable: true,
            revision: revision.clone(),
            artifact: None,
        });
    }
    rows.sort_by(|a, b| {
        pin_order
            .get(&format!("{}:{}", a.kind, a.id))
            .copied()
            .unwrap_or(usize::MAX)
            .cmp(
                &pin_order
                    .get(&format!("{}:{}", b.kind, b.id))
                    .copied()
                    .unwrap_or(usize::MAX),
            )
            .then_with(|| {
                if query.important {
                    (a.kind == "report").cmp(&(b.kind == "report"))
                } else {
                    std::cmp::Ordering::Equal
                }
            })
            .then_with(|| b.updated_at.cmp(&a.updated_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    let artifact_digest = digest(
        &serde_json::to_vec(&artifacts.values().map(artifact_json).collect::<Vec<_>>())
            .unwrap_or_default(),
    );
    let page_revision = format!(
        "{}:{}:{}:{}:{}",
        snapshot.revision,
        project.preferences_revision,
        query.all,
        query.important,
        artifact_digest
    );
    let offset = match query.cursor.as_deref() {
        Some(encoded) => {
            let cursor: RevisionOffsetCursor = cursor::decode(encoded)?;
            if cursor.revision != page_revision {
                return Err(source_changed("Reload the materials."));
            }
            cursor.offset.min(rows.len())
        }
        None => 0,
    };
    let total = rows.len();
    let selected = rows
        .iter()
        .skip(offset)
        .take(query.limit)
        .collect::<Vec<_>>();
    let next_cursor = (offset + selected.len() < total)
        .then(|| {
            cursor::encode(&RevisionOffsetCursor {
                revision: page_revision,
                offset: offset + selected.len(),
            })
            .ok()
        })
        .flatten();
    Ok(json!({
        "status":"ready",
        "total":total,
        "nextCursor":next_cursor,
        "documents":selected.iter().map(|row| row.document(&project.id)).collect::<Vec<_>>(),
    }))
}

#[derive(Clone)]
struct MaterialRow {
    id: String,
    kind: String,
    title: String,
    path: String,
    updated_at: String,
    status: String,
    unavailable: bool,
    revision: String,
    artifact: Option<Value>,
}

impl MaterialRow {
    fn document(&self, project_id: &str) -> Value {
        json!({
            "id":self.id,
            "project_id":project_id,
            "revision":self.revision,
            "kind":match self.kind.as_str() {"spec" => "spec", "report" => "report", _ => "plan"},
            "document_type":self.kind,
            "title":sanitize_public_text(&self.title, ""),
            "status":self.status,
            "safe_path_label":sanitize_public_text(&self.path, ""),
            "markdown":"",
            "updated_at":self.updated_at,
            "unavailable":self.unavailable,
            "artifact":self.artifact,
        })
    }
}

async fn read_pinned_artifacts(
    application: &AppApplication,
    project_id: &str,
    pins: &[(String, String, String)],
) -> Result<HashMap<String, DashboardArtifact>, GatewayApplicationError> {
    let artifacts = pins
        .iter()
        .filter(|(kind, _, _)| kind == "artifact")
        .map(|(_, id, _)| id.clone())
        .collect::<Vec<_>>();
    let mut result = HashMap::new();
    for id in artifacts {
        let key = project_id.to_owned();
        let source_id = id.clone();
        let artifact = application
            .storage
            .execute(move |db| read_artifact(db, &key, &source_id))
            .await
            .map_err(app_error)?;
        if let Some(artifact) = artifact
            && pins.iter().any(|(kind, pin_id, revision)| {
                kind == "artifact" && pin_id == &id && revision == &artifact.revision
            })
        {
            result.insert(id, artifact);
        }
    }
    Ok(result)
}

fn artifact_json(artifact: &DashboardArtifact) -> Value {
    let file = &artifact.file;
    json!({
        "id":artifact.id,
        "session_id":artifact.session_id,
        "project_id":artifact.project_id,
        "message_id":artifact.message_id,
        "turn_id":artifact.turn_id,
        "file_id":file.file_id,
        "title":sanitize_public_text(&file.safe_name, ""),
        "revision":artifact.revision,
        "mime_type":file.mime_type,
        "safe_path_label":sanitize_public_text(&file.safe_name, ""),
        "created_at":file.created_at,
    })
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
