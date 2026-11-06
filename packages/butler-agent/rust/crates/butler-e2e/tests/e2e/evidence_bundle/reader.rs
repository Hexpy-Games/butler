use super::*;
use butler_turn::btcc::{
    storage::{OperationResultRepository, read_activated_storage_manifest},
    *,
};
use serde_json::json;

async fn reader(
    run: &mut Run,
) -> Result<
    (
        BtccStorage,
        OperationResultReplayFactory,
        OperationResultScope,
    ),
    HarnessError,
> {
    run.scenario.agent.terminate().await?;
    let path = run.scenario.sandbox.data.join("agent-runtime/btcc.sqlite");
    let db = Connection::open(&path)?;
    let (turn_id, session_id): (String,String) = db.query_row(
        "SELECT parent_turn_id,parent_session_id FROM btcc_session_relations WHERE relation_id=(SELECT relation_id FROM btcc_steward_results WHERE result_id=?1)", [run.bundle.strip_prefix("evidence:").unwrap()], |r| Ok((r.get(0)?,r.get(1)?)))?;
    let fixture = TestStorageFixture::activated();
    let mut config = fixture.config("bundle-reader");
    config.activation.manifest_id = read_activated_storage_manifest(&path).unwrap();
    config.path = path;
    let storage = BtccStorage::open(config).await.unwrap();
    let factory = OperationResultReplayFactory::new(
        ExactResultReplaySelection {
            mode: ReplayMode::Available,
            exact_read_capability: true,
        },
        Arc::new(ToolJournalRepository::new(
            storage.clone(),
            Arc::new(|| "now".into()),
        )),
        Arc::new(OperationResultRepository::new(storage.clone(), None)),
    );
    let scope = OperationResultScope {
        turn_id,
        session_id,
        turn_revision: 1,
        project_ref: None,
        work_id: None,
    };
    Ok((storage, factory, scope))
}

#[tokio::test]
async fn evb_02_every_item_pages_in_bundle_order_and_reads_original_bytes()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut run = setup().await?;
    let (storage, factory, scope) = reader(&mut run).await?;
    let runtime = factory.bind(scope).unwrap().unwrap();
    let mut cursor = 0.0;
    let mut actual = Vec::new();
    let mut through = Value::Null;
    let mut pages = 0;
    loop {
        let page = runtime
            .list_tool(
                json!({"evidence":run.bundle,"cursor":cursor,"through":through,"limit":10})
                    .as_object()
                    .unwrap(),
            )
            .await
            .unwrap();
        through = page["through"].clone();
        pages += 1;
        for entry in page["entries"].as_array().unwrap() {
            let exact = entry["exact_read"].as_object().unwrap();
            let bytes = read_all(runtime.as_ref(), exact).await;
            assert_eq!(format!("{:x}", Sha256::digest(&bytes)), exact["sha256"]);
            actual.push(exact["result_ref"].as_str().unwrap().to_owned());
            let mut no_grant = exact.clone();
            no_grant.remove("evidence");
            assert!(
                runtime.read_tool(&no_grant).await.is_err(),
                "child access requires the bundle grant"
            );
        }
        let Some(next) = page["next_cursor"].as_f64() else {
            break;
        };
        assert!(next > cursor);
        cursor = next;
    }
    assert_eq!(actual, run.refs);
    eprintln!(
        "EVB-02: {} exact items across {pages} pages; every sha256 matched",
        actual.len()
    );
    storage.close().await.unwrap();
    run.finish().await
}

#[tokio::test]
async fn evb_03_an_unrelated_parent_cannot_list_or_read_the_bundle() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut run = setup().await?;
    let (storage, factory, mut scope) = reader(&mut run).await?;
    let authorized = factory.bind(scope.clone()).unwrap().unwrap();
    let page = authorized
        .list_tool(json!({"evidence":run.bundle}).as_object().unwrap())
        .await
        .unwrap();
    BtccRepositories::new(storage.clone(), None)
        .load_or_admit(&test_prepared_turn())
        .await
        .unwrap();
    scope.turn_id = "turn".into();
    scope.session_id = "session".into();
    let unrelated = factory.bind(scope).unwrap().unwrap();
    let error = unrelated
        .list_tool(json!({"evidence":run.bundle}).as_object().unwrap())
        .await
        .unwrap_err();
    assert_eq!(error.code(), "operation_result_missing_or_scope_mismatch");
    let error = unrelated
        .read_tool(page["entries"][0]["exact_read"].as_object().unwrap())
        .await
        .unwrap_err();
    assert_eq!(error.code(), "operation_result_missing_or_scope_mismatch");
    storage.close().await.unwrap();
    run.finish().await
}

async fn read_all(
    runtime: &dyn OperationResultRuntime,
    exact: &serde_json::Map<String, Value>,
) -> Vec<u8> {
    let mut args = exact.clone();
    let mut bytes = Vec::new();
    loop {
        let read = runtime.read_tool(&args).await.unwrap();
        assert_eq!(read["result_sha256"], exact["sha256"]);
        assert_eq!(read["offset"], args["offset"]);
        assert_eq!(read["encoding"], "utf8");
        bytes.extend(read["data"].as_str().unwrap().as_bytes());
        let Some(next) = read["next_offset"].as_u64() else {
            assert_eq!(
                bytes.len(),
                usize::try_from(read["total_bytes"].as_u64().unwrap()).unwrap()
            );
            return bytes;
        };
        assert!(next > args["offset"].as_u64().unwrap());
        args.insert("offset".into(), next.into());
    }
}
