use std::sync::Arc;

use serde_json::json;

use super::collect;
use butler_core::json::JsonDocument;
use butler_turn::btcc::{
    ArtifactKind, BtccRepositories, BtccStorage, FinalArtifact, JournalCloseout,
    TestStorageFixture, ToolJournalFinish, ToolJournalFinishStatus, ToolJournalRepository,
    ToolJournalStart, TurnStore, test_prepared_turn,
};

#[tokio::test]
async fn completed_command_artifact_projects_from_reopened_real_journal() {
    let fixture = TestStorageFixture::activated();
    let storage = BtccStorage::open(fixture.config("closeout-first"))
        .await
        .unwrap();
    BtccRepositories::new(storage.clone(), None)
        .load_or_admit(&test_prepared_turn())
        .await
        .unwrap();
    let journal = Arc::new(ToolJournalRepository::new(
        storage.clone(),
        Arc::new(|| "now".into()),
    ));
    journal
        .start(ToolJournalStart {
            turn_id: "turn".into(),
            call_id: "command".into(),
            tool_name: "run_command".into(),
            raw_arguments: "{}".into(),
            arguments: json!({}),
        })
        .await
        .unwrap();
    journal.finish(ToolJournalFinish {
        call_id: "command".into(), status: ToolJournalFinishStatus::Completed,
        result: Some(JsonDocument::from_encoded(
            r#"{"ok":true,"verified_output_files":[{"path":"artifacts/report.csv","size_bytes":12,"artifact_kind":"csv_file"}]}"#.into()
        ).unwrap()), changed_files: None, error_code: None,
    }).await.unwrap();
    storage.close().await.unwrap();
    drop(journal);
    let reopened = BtccStorage::open(fixture.config("closeout-reopen"))
        .await
        .unwrap();
    let journal = Arc::new(ToolJournalRepository::new(
        reopened.clone(),
        Arc::new(|| "now".into()),
    ));
    let closeout = collect(&journal, "turn", "").await.unwrap();
    assert_eq!(closeout.artifacts.len(), 1);
    assert_eq!(
        closeout.artifacts[0].id,
        "artifact-e1daee22babaafad9904a1b6af84513e2bc678e4b97a54c7b7742284720f74a5"
    );
    assert_eq!(
        closeout.artifacts[0].safe_path_label,
        "artifacts/report.csv"
    );
    assert_eq!(
        closeout.changed_files,
        [] as [butler_turn::btcc::ChangedFileSummary; 0]
    );
    reopened.close().await.unwrap();
}

async fn finished(
    journal: &ToolJournalRepository,
    call: &str,
    tool: &str,
    arguments: serde_json::Value,
    result: serde_json::Value,
) {
    journal
        .start(ToolJournalStart {
            turn_id: "turn".into(),
            call_id: call.into(),
            tool_name: tool.into(),
            raw_arguments: arguments.to_string(),
            arguments,
        })
        .await
        .unwrap();
    journal
        .finish(ToolJournalFinish {
            call_id: call.into(),
            status: ToolJournalFinishStatus::Completed,
            result: Some(JsonDocument::from_value(&result).unwrap()),
            changed_files: None,
            error_code: None,
        })
        .await
        .unwrap();
}

fn capture(path: &str, page: &str) -> serde_json::Value {
    json!({"status":"ok","schema":"butler.browser-capture.v1","tab":"t1",
        "artifacts":[{"path":path,"kind":"image","mime_type":"image/jpeg","size_bytes":10}],
        "untrusted_content":{"fields":[],"url":page}})
}

fn file(path: &str, kind: ArtifactKind, page: Option<&str>) -> FinalArtifact {
    FinalArtifact {
        id: path.into(),
        kind,
        title: path.into(),
        safe_path_label: path.into(),
        mime_type: None,
        size_bytes: None,
        created_at: None,
        source_url: page.map(str::to_owned),
    }
}

/// The demo: a card pictures a product with its collected photo while a capture
/// of that product page was also taken. The reply shows the photo once; a capture
/// of a page no block pictures still accompanies the reply.
#[tokio::test]
async fn capture_of_a_pictured_item_page_is_not_attached_again() {
    let fixture = TestStorageFixture::activated();
    let storage = BtccStorage::open(fixture.config("closeout-pictured"))
        .await
        .unwrap();
    BtccRepositories::new(storage.clone(), None)
        .load_or_admit(&test_prepared_turn())
        .await
        .unwrap();
    let journal = Arc::new(ToolJournalRepository::new(
        storage.clone(),
        Arc::new(|| "now".into()),
    ));
    let product = "https://www.shop.example/goods/A1?ref=list";
    let other = "https://other.example/checkout";
    finished(
        &journal,
        "shot-a",
        "browser_screenshot",
        json!({}),
        capture("artifacts/public-data/browser-a.jpg", product),
    )
    .await;
    finished(
        &journal,
        "shot-b",
        "browser_screenshot",
        json!({}),
        capture("artifacts/public-data/browser-b.jpg", other),
    )
    .await;
    let spec = json!({"v":1,"blocks":[{"type":"cards","items":[
        {"title":"A1","img":"img_aaaaaaaaaa","source":"https://shop.example/goods/A1"}]}]});
    finished(
        &journal,
        "blocks",
        "answer_blocks",
        spec,
        json!({"ok":true}),
    )
    .await;
    let own = collect(&journal, "turn", "").await.unwrap();
    assert_eq!(own.artifacts.len(), 2, "collection keeps both captures");
    assert_eq!(own.artifacts[0].source_url.as_deref(), Some(product));
    let shown = super::without_pictured(own);
    let paths: Vec<_> = shown
        .artifacts
        .iter()
        .map(|a| a.safe_path_label.as_str())
        .collect();
    assert_eq!(paths, ["artifacts/public-data/browser-b.jpg"]);
    assert_eq!(shown.answer_blocks.len(), 1);
    storage.close().await.unwrap();
}

/// A delegated result's captures arrive in the child payload with their page;
/// the parent's own blocks decide, and files without a pictured page stay.
#[test]
fn delegated_captures_follow_the_parent_blocks() {
    let page = Some("https://shop.example/goods/A1");
    let child = JournalCloseout {
        artifacts: vec![
            file(
                "artifacts/public-data/browser-a.jpg",
                ArtifactKind::Image,
                page,
            ),
            file("artifacts/chart.png", ArtifactKind::Image, None),
            file("artifacts/shop.csv", ArtifactKind::CsvFile, page),
        ],
        changed_files: vec![],
        answer_blocks: vec![],
    };
    let wire = serde_json::to_value(&child.artifacts[0]).unwrap();
    assert_eq!(wire["sourceUrl"], "https://shop.example/goods/A1");
    let own = JournalCloseout {
        artifacts: vec![],
        changed_files: vec![],
        answer_blocks: vec![json!({"call_id":"c","set_ids":[],"spec":{"v":1,"blocks":[
            {"type":"gallery","items":[{"img":"img_aaaaaaaaaa","source":"https://www.shop.example/goods/A1?x=1"}]}]}})],
    };
    let shown = super::without_pictured(super::merge_files(child, own));
    let paths: Vec<_> = shown
        .artifacts
        .iter()
        .map(|a| a.safe_path_label.as_str())
        .collect();
    assert_eq!(paths, ["artifacts/chart.png", "artifacts/shop.csv"]);
    let unpictured = super::without_pictured(JournalCloseout {
        artifacts: vec![file(
            "artifacts/public-data/browser-a.jpg",
            ArtifactKind::Image,
            page,
        )],
        changed_files: vec![],
        answer_blocks: vec![],
    });
    assert_eq!(
        unpictured.artifacts.len(),
        1,
        "without pictured blocks every capture stays"
    );
}
