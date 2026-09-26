use super::path;
use super::*;

struct WritesThenReject(std::path::PathBuf);
impl RegisteredWritePort for WritesThenReject {
    fn write<'a>(&'a self, prepared: PreparedWrite) -> EffectFuture<'a, Value> {
        Box::pin(async move {
            std::fs::write(self.0.join(&prepared.path), &prepared.content)
                .map_err(|error| EffectFailure::adapter(error.to_string()))?;
            Ok(json!({"ok":false,"error":"rejected_after_write",
                "changed_file":{"source":"registered"}}))
        })
    }
}

#[test]
fn actual_bun_write_effect_normalization_matches() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!("bun-golden.json")).unwrap();
    let workspace = std::path::Path::new(fixture["workspacePath"].as_str().unwrap());
    for case in fixture["cases"].as_array().unwrap() {
        let actual = path::input(&case["input"], workspace);
        if let Some(expected) = case["normalized"].as_object() {
            assert_eq!(
                actual.unwrap(),
                serde_json::Value::Object(expected.clone()),
                "{case}"
            );
        } else {
            assert_eq!(
                actual.unwrap_err().message,
                case["error"].as_str().unwrap(),
                "{case}"
            );
        }
    }
    for case in fixture["targets"].as_array().unwrap() {
        let actual = path::target(case["target"].as_str().unwrap());
        if let Some(expected) = case["normalized"].as_str() {
            assert_eq!(actual.unwrap(), expected, "{case}");
        } else {
            assert_eq!(
                actual.unwrap_err().message,
                case["error"].as_str().unwrap(),
                "{case}"
            );
        }
    }
}

#[tokio::test]
async fn actual_bun_observation_precedes_registered_rejection_and_attempt_fallback_matches() {
    let fixture: Value = serde_json::from_str(include_str!("bun-golden.json")).unwrap();
    let root = std::env::temp_dir().join(format!("butler-effect-observe-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let adapter = WorkspaceFileEffectAdapter::new(
        EffectFileScope {
            workspace: root.clone(),
            butler_data: root.join("data"),
            protected_roots: vec![],
            installation_root: None,
        },
        Arc::new(WritesThenReject(root.clone())),
    );
    let signal = CancellationToken::new();
    let input = adapter
        .normalize_input(&json!({"path":"a","content":"actual bytes"}))
        .unwrap();
    let dispatched = adapter
        .dispatch("workspace:a", &input, "source", &signal)
        .await
        .unwrap();
    let AdapterOutcome::Applied(result) = dispatched else {
        panic!("expected observed applied")
    };
    assert_eq!(
        result.read::<serde_json::Value>().unwrap(),
        fixture["observation"]["dispatch"]["result"]
    );
    assert_eq!(result.as_str(), fixture["observation"]["resultJson"]);
    let missing = adapter
        .normalize_input(&json!({"path":"b","content":"actual bytes"}))
        .unwrap();
    assert!(matches!(
        adapter
            .reconcile("workspace:b", &missing, "source", &signal, 0, None)
            .await
            .unwrap(),
        AdapterOutcome::NotApplied(_)
    ));
    let once = adapter
        .reconcile("workspace:b", &missing, "source", &signal, 1, None)
        .await
        .unwrap();
    let AdapterOutcome::Uncertain(Some(error)) = once else {
        panic!("expected uncertain")
    };
    assert_eq!(error.code, fixture["observation"]["once"]["error"]["code"]);
    assert_eq!(
        error.message,
        fixture["observation"]["once"]["error"]["message"]
    );
    std::fs::remove_dir_all(&root).unwrap();
}
