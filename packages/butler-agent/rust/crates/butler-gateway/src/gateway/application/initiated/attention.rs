//! One durable notice per run and exact action, independent of its source session.
use super::{super::AppStorageError, outbox};
use rusqlite::Connection;
use serde_json::{Value, json};

pub(in crate::gateway::application) fn enqueue_attention(
    db: &Connection,
    automation: &str,
    run: &str,
    action: &Value,
    language: &str,
    now: &str,
) -> Result<(), AppStorageError> {
    let approval: butler_turn::btcc::AuthorityApproval =
        serde_json::from_value(action["approval"].clone()).map_err(outbox::json_error)?;
    let title: String = db
        .query_row(
            "SELECT title FROM app_automations WHERE id=?1",
            [automation],
            |r| r.get(0),
        )
        .map_err(AppStorageError::sqlite)?;
    let identity = action
        .get("identity")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            json!({"capability":action["capability"],"approval":approval}).to_string()
        });
    let digest = butler_turn::btcc::digest_identity(&identity);
    let source = format!("approval-needed:{run}:{digest}");
    let id = format!(
        "approval-needed-{}",
        butler_turn::btcc::digest_identity(&source)
    );
    let label = capability_label(approval.action_kind, language);
    let text = if language.starts_with("ko") {
        format!("확인 필요 · {label} · {title}")
    } else {
        format!("Needs your OK · {label} · {title}")
    };
    let mut payload = json!({"automation_id":automation,"automation_title":title,"run_id":run,"approval":approval,"label":label});
    if let Some(work) = action.get("work_session_id").and_then(Value::as_str) {
        payload["work_session_id"] = json!(work);
    }
    outbox::enqueue(
        db,
        (&id, "general"),
        &source,
        "approval_needed",
        &text,
        &payload,
        now,
    )
}

fn capability_label(kind: butler_turn::btcc::ApprovalActionKind, language: &str) -> &'static str {
    use butler_turn::btcc::ApprovalActionKind::{
        CreateWorktree, EditFiles, EditImage, GenerateImage, ManageSchedule, NetworkCommand, Other,
        RestartService, RunCommand, StartConversation, SwitchFolder, UpdateProject, UseConnector,
        WebRequest,
    };
    let (ko, en) = match kind {
        EditFiles => ("파일 수정", "Edit files"),
        RunCommand => ("명령 실행", "Run command"),
        NetworkCommand => ("네트워크 명령 실행", "Run network command"),
        WebRequest => ("웹 요청", "Web request"),
        UseConnector => ("연결된 도구 사용", "Use connected tool"),
        GenerateImage => ("이미지 생성", "Generate image"),
        EditImage => ("이미지 편집", "Edit image"),
        ManageSchedule => ("예약 작업 관리", "Manage schedule"),
        UpdateProject => ("프로젝트 기록 변경", "Update project records"),
        StartConversation => ("대화 시작", "Start conversation"),
        RestartService => ("버틀러 다시 시작", "Restart Butler"),
        CreateWorktree => ("워크트리 생성", "Create worktree"),
        SwitchFolder => ("작업 폴더 이동", "Move working folder"),
        Other => ("기타 동작", "Other action"),
    };
    if language.starts_with("ko") { ko } else { en }
}
