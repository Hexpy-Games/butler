use super::path;
use super::*;

struct WritesThenReject(std::path::PathBuf);
impl RegisteredWritePort for WritesThenReject {
    fn write(&self, prepared: PreparedWrite) -> EffectFuture<'_, Value> {
        Box::pin(async move {
            std::fs::write(self.0.join(&prepared.path), &prepared.content)
                .map_err(|error| EffectFailure::adapter(error.to_string()))?;
            Ok(json!({"ok":false,"error":"rejected_after_write",
                "changed_file":{"source":"registered"}}))
        })
    }
}
#[test]
fn write_effect_inputs_and_targets_normalize_inside_the_workspace() {
    let workspace = std::path::Path::new("/tmp/butler-workspace-fixture");
    for (input, expected) in [
        (
            json!({"path":"a\\b","content":"x"}),
            Ok(json!({"path":"a/b","content":"x","create_parents":false})),
        ),
        (
            json!({"path":"a//b","content":"x","create_parents":true}),
            Ok(json!({"path":"a/b","content":"x","create_parents":true})),
        ),
        (
            json!({"path":"/tmp/butler-workspace-fixture/a","content":"x"}),
            Ok(json!({"path":"a","content":"x","create_parents":false})),
        ),
        (
            json!({"path":"a/","content":"x"}),
            Ok(json!({"path":"a/","content":"x","create_parents":false})),
        ),
        (
            json!({"path":"../a","content":"x"}),
            Err("write_file effect path cannot traverse a parent directory"),
        ),
        (
            json!({"path":"a","content":"x","create_parents":null}),
            Err("write_file effect create_parents must be a boolean"),
        ),
        (
            json!({"path":"a","content":1}),
            Err("write_file effect content must be a string"),
        ),
    ] {
        match expected {
            Ok(normalized) => assert_eq!(
                path::input(&input, workspace).unwrap(),
                normalized,
                "{input}"
            ),
            Err(message) => assert_eq!(
                path::input(&input, workspace).unwrap_err().message(),
                message,
                "{input}"
            ),
        }
    }
    for (target, expected) in [
        ("workspace:a\\b", Ok("workspace:a/b")),
        ("workspace:a//b", Ok("workspace:a/b")),
        ("workspace:a/", Ok("workspace:a/")),
        (
            "workspace:../a",
            Err("write_file effect path cannot traverse a parent directory"),
        ),
        (
            "workspace:/a",
            Err("write_file effect path must be workspace-relative"),
        ),
        (
            "bad:a",
            Err("write_file effect target must use workspace:<relative-path>"),
        ),
    ] {
        match expected {
            Ok(normalized) => assert_eq!(path::target(target).unwrap(), normalized),
            Err(message) => assert_eq!(path::target(target).unwrap_err().message(), message),
        }
    }
}

#[tokio::test]
async fn observed_write_precedes_registered_rejection_and_reconcile_is_conservative() {
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
    let result = result.read::<serde_json::Value>().unwrap();
    assert_eq!(result["ok"], true);
    assert_eq!(result["effect"], "workspace_file_write");
    assert_eq!(result["bytes"], 12);
    assert_eq!(result["created_from_absent"], true);
    assert_eq!(result["changed_file"], json!({"source":"registered"}));
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
    assert_eq!(error.code, "workspace_file_state_mismatch");
    std::fs::remove_dir_all(&root).unwrap();
}
