
use super::*;
use crate::btcc::{EffectFuture, RegisteredEditPort, WorkspaceFileEditEffectAdapter};
use crate::workspace::EffectFileScope;

struct UnusedRegisteredEdit;
impl RegisteredEditPort for UnusedRegisteredEdit {
    fn edit<'a>(&'a self, _: Value) -> EffectFuture<'a, Value> {
        Box::pin(async { unreachable!("recovery never dispatches") })
    }
}

#[test]
fn reconstructs_same_durable_identity_before_and_after_a_single_edit() {
    let root = std::env::temp_dir().join(format!("butler-legacy-edit-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let scope = EffectFileScope {
        workspace: root.clone(),
        butler_data: root.join("data"),
        protected_roots: vec![],
        installation_root: None,
    };
    let adapter: Arc<dyn EffectAdapter> = Arc::new(WorkspaceFileEditEffectAdapter::new(
        scope,
        Arc::new(UnusedRegisteredEdit),
    ));
    let edit = Edit {
        path: "doc.txt".into(),
        hint: None,
        old_text: "beta".into(),
        new_text: "gamma".into(),
        expected: None,
    };
    let before = "alpha beta";
    let after = "alpha gamma";
    let prepared = candidate(&edit, 1, &sha(before), &sha(after), &adapter).unwrap();
    let identity = effect_input_sha256(&prepared).unwrap();
    for text in [before, after] {
        let state = State {
            before: sha(text),
            text: text.into(),
            original: text.into(),
        };
        assert_eq!(
            recover(&edit, &state, &identity, &adapter).unwrap(),
            prepared
        );
    }
    let state = State {
        before: sha(
            "beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta",
        ),
        text:
            "beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta"
                .into(),
        original: String::new(),
    };
    assert_eq!(
        recover(&edit, &state, &identity, &adapter)
            .unwrap_err()
            .code,
        "edit_file_reconciliation_mismatch"
    );
    std::fs::remove_dir_all(root).unwrap();
}
