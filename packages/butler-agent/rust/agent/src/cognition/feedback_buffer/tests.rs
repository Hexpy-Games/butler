use std::{fs, io::Write, sync::Arc};

use crate::{
    cognition::CognitionPathEnvironment,
    coordination::{
        CognitionCoordinationHost, CognitionProcessStatus, CognitionWriteCoordinator,
        CoordinationResult,
    },
};

use super::{
    FeedbackBufferService, FeedbackCounts, FeedbackPriority, FeedbackPrivacyClass, FeedbackStatus,
    parse_entry,
};

const NOW: &str = "2026-09-23T00:00:00.000Z";

struct TestHost;

impl CognitionCoordinationHost for TestHost {
    fn process_id(&self) -> u32 {
        std::process::id()
    }
    fn hostname(&self) -> CoordinationResult<String> {
        Ok("feedback-buffer-test".into())
    }
    fn process_status(&self, _pid: u64) -> CognitionProcessStatus {
        CognitionProcessStatus::Alive
    }
    fn new_uuid(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
    fn now_epoch_millis(&self) -> i64 {
        crate::js_date::parse_iso_millis(NOW).unwrap()
    }
    fn now_iso(&self) -> String {
        NOW.into()
    }
}

#[test]
fn parsed_feedback_preserves_extra_metadata_and_multiline_text() {
    let source = concat!(
        "fb_roundtrip active\n",
        "- created_at: 2026-09-22T12:00:00.000Z\n",
        "- updated_at: 2026-09-22T12:01:00.000Z\n",
        "- priority: critical\n",
        "- scope: user\n",
        "- category: preference\n",
        "- target_ref: response_style\n",
        "- promotion_target: profile_candidate\n",
        "- review_after: 2026-09-22T12:00:00.000Z\n",
        "- expires_at: null\n",
        "- supersedes: [\"fb_old\"]\n",
        "- conflicts_with: []\n",
        "- privacy_class: private\n",
        "- source_conversation_session_id: session-7\n",
        "- source_operation_id: op-3\n",
        "\n",
        "Keep the correction scoped to this conversation.\n",
        "- this body line is not metadata\n",
        "Preserve the second sentence.\n",
    );
    let parsed = parse_entry(source, NOW);
    assert_eq!(parsed.feedback_id, "fb_roundtrip");
    assert_eq!(parsed.status, FeedbackStatus::Active);
    assert_eq!(parsed.priority, FeedbackPriority::Critical);
    assert_eq!(parsed.privacy_class, FeedbackPrivacyClass::Private);
    assert_eq!(
        parsed.extra_fields["source_conversation_session_id"],
        "session-7"
    );
    assert_eq!(parsed.extra_fields["source_operation_id"], "op-3");
    assert_eq!(
        parsed.text,
        "Keep the correction scoped to this conversation.\n- this body line is not metadata\nPreserve the second sentence."
    );
}

#[test]
fn counts_apply_source_defaults_expiry_and_active_profile_filter() {
    let data_root = std::env::temp_dir().join(format!(
        "butler-feedback-buffer-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let feedback_root = data_root.join("cognition/feedback");
    fs::create_dir_all(&feedback_root).unwrap();
    fs::write(
        feedback_root.join("feedback.md"),
        concat!(
            "## malformed unrecognized-status\n",
            "- priority: urgent\n",
            "- privacy_class: internal\n",
            "\nDefaulted record.\n",
            "## fb_valid active\n",
            "- promotion_target: profile_candidate\n",
            "- expires_at: 2026-09-23T00:00:00.001Z\n",
            "- source_conversation_message_id: preserved\n",
            "\nValid until after now.\n",
            "## fb_expired active\n",
            "- promotion_target: profile_candidate\n",
            "- expires_at: 2026-09-22T23:59:59.999Z\n",
            "\nExpired.\n",
            "## fb_invalid_expiry active\n",
            "- promotion_target: profile_candidate\n",
            "- expires_at: not-a-date\n",
            "\nInvalid expiry remains active.\n",
            "## fb_applied applied\n",
            "- promotion_target: profile_candidate\n",
            "\nAlready resolved.\n",
        ),
    )
    .unwrap();
    let mut feedback_file = fs::OpenOptions::new()
        .append(true)
        .open(feedback_root.join("feedback.md"))
        .unwrap();
    feedback_file
        .write_all(b"## fb_large active\n- promotion_target: profile_candidate\n\n")
        .unwrap();
    feedback_file
        .write_all(&vec![b'x'; 4 * 1024 * 1024 + 1])
        .unwrap();
    feedback_file.write_all(b"\n").unwrap();
    drop(feedback_file);
    let quality_operations = feedback_root.join("quality-operations.jsonl");
    fs::write(&quality_operations, "read-only sentinel\n").unwrap();

    let coordinator = Arc::new(CognitionWriteCoordinator::new(Arc::new(TestHost)).unwrap());
    let service = FeedbackBufferService::new(
        data_root.clone(),
        CognitionPathEnvironment::default(),
        coordinator,
    );
    let counts = service
        .counts(crate::js_date::parse_iso_millis(NOW).unwrap())
        .unwrap();
    let malformed = parse_entry(
        "malformed unrecognized-status\n- priority: urgent\n- privacy_class: internal\n\nDefaulted record.",
        NOW,
    );

    assert_eq!(
        counts,
        FeedbackCounts {
            total_count: 6,
            status_active_count: 4,
            active_count: 3,
            active_profile_candidate_count: 3,
        }
    );
    assert_eq!(malformed.status, FeedbackStatus::NeedsClarification);
    assert_eq!(malformed.priority, FeedbackPriority::High);
    assert_eq!(malformed.privacy_class, FeedbackPrivacyClass::Private);
    assert_eq!(malformed.scope, "global");
    assert_eq!(malformed.category, "unrouted");
    assert_eq!(
        fs::read_to_string(quality_operations).unwrap(),
        "read-only sentinel\n"
    );
    fs::remove_dir_all(data_root).unwrap();
}

#[tokio::test]
async fn applied_resolution_preserves_other_feedback_and_extra_fields() {
    let data_root = std::env::temp_dir().join(format!(
        "butler-feedback-resolve-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let feedback_root = data_root.join("cognition/feedback");
    fs::create_dir_all(&feedback_root).unwrap();
    let path = feedback_root.join("feedback.md");
    fs::write(
        &path,
        "## fb_target active\n- category: source_quality\n- target_ref: source:one\n- source_operation_id: op-1\n\nPrivate feedback.\n\n## fb_other active\n- target_ref: knowhow:other\n\nKeep active.\n",
    )
    .unwrap();
    let service = FeedbackBufferService::new(
        data_root.clone(),
        CognitionPathEnvironment::default(),
        Arc::new(CognitionWriteCoordinator::new(Arc::new(TestHost)).unwrap()),
    );
    service.resolve_applied("fb_target").await.unwrap();
    let contents = fs::read_to_string(&path).unwrap();
    assert!(contents.contains("## fb_target applied"));
    assert!(contents.contains("- source_operation_id: op-1"));
    assert!(contents.contains("Private feedback."));
    assert!(contents.contains("## fb_other active"));
    assert!(contents.contains("Keep active."));
    assert_eq!(
        service
            .counts(crate::js_date::parse_iso_millis(NOW).unwrap())
            .unwrap()
            .status_active_count,
        1
    );
    fs::remove_dir_all(data_root).unwrap();
}
