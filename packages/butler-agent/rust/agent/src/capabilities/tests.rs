use std::path::PathBuf;
use std::sync::Arc;

mod arguments;
mod lifecycle;
mod list_files;
mod mutations;
mod registry_read;
mod source_gaps;

use serde_json::{Value, json};
use uuid::Uuid;

use super::{CapabilityInvocation, NativeCapabilities};
use crate::skills::NativeSkills;
use crate::workspace::{NativeWorkspaceFiles, WorkspaceReference};

impl NativeCapabilities {
    pub(crate) fn new(
        files: Arc<NativeWorkspaceFiles>,
        mutations: Arc<crate::workspace::WorkspaceMutations>,
    ) -> Self {
        let root = std::env::temp_dir().join("butler-native-empty-skills");
        Self::with_skills(
            files,
            mutations,
            Arc::new(NativeSkills::new(root.clone(), root)),
        )
    }
}

struct Fixture {
    root: PathBuf,
    files: Arc<NativeWorkspaceFiles>,
    capabilities: NativeCapabilities,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("butler-k1a-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let files = Arc::new(NativeWorkspaceFiles::new(2));
        let capabilities = NativeCapabilities::new(
            Arc::clone(&files),
            Arc::new(crate::workspace::WorkspaceMutations::new()),
        );
        Self {
            root,
            files,
            capabilities,
        }
    }
    fn write(&self, name: &str, bytes: &[u8]) {
        std::fs::write(self.root.join(name), bytes).unwrap();
    }
    async fn invoke(&self, call: &Value, reference: Option<&WorkspaceReference>) -> Value {
        self.capabilities
            .invoke(
                "read_file",
                CapabilityInvocation {
                    call,
                    workspace_reference: reference,
                    workspace_path: Some(&self.root),
                    butler_data: &self.root,
                    protected_ledger_roots: &[],
                    allowed_tools_and_effects: None,
                    mutation_scope: None,
                    installation_root: None,
                },
            )
            .await
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn supplied_protected_root_and_workspace_reference_are_live() {
    let fixture = Fixture::new();
    fixture.write("a.txt", b"one");
    let protected = fixture.root.join(".project-ledger");
    std::fs::create_dir(&protected).unwrap();
    std::fs::write(protected.join("a.txt"), b"private").unwrap();
    let call = json!({ "arguments": { "requests": [{ "path": "a.txt" }], "workspace_root": protected.to_string_lossy() } });
    let rust = fixture
        .capabilities
        .invoke(
            "read_file",
            CapabilityInvocation {
                call: &call,
                workspace_reference: None,
                workspace_path: Some(&fixture.root),
                butler_data: &fixture.root,
                protected_ledger_roots: std::slice::from_ref(&protected),
                allowed_tools_and_effects: None,
                mutation_scope: None,
                installation_root: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(rust["error"], "protected_path");
    let reference = WorkspaceReference::unavailable("session_workspace_unavailable");
    let regular = json!({ "arguments": { "requests": [{ "path": "a.txt" }] } });
    let error = fixture
        .capabilities
        .invoke(
            "read_file",
            CapabilityInvocation {
                call: &regular,
                workspace_reference: Some(&reference),
                workspace_path: Some(&fixture.root),
                butler_data: &fixture.root,
                protected_ledger_roots: &[],
                allowed_tools_and_effects: None,
                mutation_scope: None,
                installation_root: None,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "session_workspace_unavailable");
    reference.set(fixture.root.to_str().unwrap()).unwrap();
    assert_eq!(
        fixture.invoke(&regular, Some(&reference)).await["files"][0]["content"],
        "one"
    );
    let alternate = Fixture::new();
    alternate.write("a.txt", b"two");
    reference.set(alternate.root.to_str().unwrap()).unwrap();
    assert_eq!(
        fixture.invoke(&regular, Some(&reference)).await["files"][0]["content"],
        "two"
    );
    fixture.files.close().await;
    alternate.files.close().await;
}

#[tokio::test]
async fn source_edge_reads_preserve_physical_bytes_and_stale_cursor() {
    let fixture = Fixture::new();
    fixture.write("first.txt", b"x");
    fixture.write("second.txt", b"yz");
    fixture.write("nul-front.txt", b"a\0b");
    let mut late_nul = vec![b'a'; 4096];
    late_nul.push(0);
    late_nul.extend_from_slice(b"tail");
    fixture.write("nul-late.txt", &late_nul);
    fixture.write("cursor.txt", "😀next".as_bytes());
    let aggregate = json!({ "arguments": { "requests": [{ "path": "first.txt" }, { "path": "second.txt" }], "max_total_bytes": 1 } });
    let result = fixture.invoke(&aggregate, None).await;
    assert_eq!(result["bytes_read"], 3);
    assert_eq!(result["files_read"], 1);
    assert_eq!(result["files"][0]["content"], "x");
    assert_eq!(result["files"][1]["pending"], true);

    let binary = json!({ "arguments": { "requests": [{ "path": "nul-front.txt" }, { "path": "nul-late.txt", "max_bytes": 2 }] } });
    let result = fixture.invoke(&binary, None).await;
    assert_eq!(result["files"][0]["error"], "binary_file_not_supported");
    assert_eq!(result["files"][1]["ok"], true);
    assert_eq!(result["files"][1]["bytes"], 4101);
    assert_eq!(result["files"][1]["content"], "aa");

    let cursor_call =
        json!({ "arguments": { "requests": [{ "path": "cursor.txt", "max_bytes": 4 }] } });
    let first = fixture.invoke(&cursor_call, None).await;
    assert_eq!(first["files"][0]["content"], "😀");
    let cursor = first["next_cursor"].as_str().unwrap();
    fixture.write("cursor.txt", "changed".as_bytes());
    let continued = json!({ "arguments": { "requests": cursor_call["arguments"]["requests"], "cursor": cursor } });
    let stale = fixture.invoke(&continued, None).await;
    assert_eq!(stale["error"], "cursor_stale");
    fixture.write("cursor.txt", "😀next".as_bytes());
    fixture.files.close().await;
}

#[tokio::test]
async fn guided_absolute_path_is_rejected_and_utf8_cursor_respects_character_boundaries() {
    let fixture = Fixture::new();
    fixture.write("e\u{301}.txt", "A😀B".as_bytes());
    let absolute = fixture.root.join("e\u{301}.txt");
    let call = json!({ "arguments": { "requests": [{ "path": absolute.to_string_lossy(), "max_bytes": 1 }] } });
    for relative_only in [false, true] {
        let rust = fixture
            .capabilities
            .invoke(
                "read_file",
                CapabilityInvocation {
                    call: &call,
                    workspace_reference: None,
                    workspace_path: Some(&fixture.root),
                    butler_data: &fixture.root,
                    protected_ledger_roots: &[],
                    allowed_tools_and_effects: relative_only.then_some(&[]),
                    mutation_scope: None,
                    installation_root: None,
                },
            )
            .await
            .unwrap();
        if relative_only {
            assert_eq!(rust["files"][0]["ok"], false);
            assert_eq!(rust["files"][0]["path"], ".");
        } else {
            assert_eq!(rust["files"][0]["ok"], true);
            assert_eq!(rust["files"][0]["content"], "A");
        }
    }
    let unicode =
        json!({ "arguments": { "requests": [{ "path": "e\u{301}.txt", "max_bytes": 1 }] } });
    let first = fixture.invoke(&unicode, None).await;
    assert_eq!(first["files"][0]["ok"], true);
    assert_eq!(first["files"][0]["content"], "A");
    fixture.files.close().await;
}

#[tokio::test]
async fn cursor_decoder_accepts_integral_json_number_spellings() {
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let fixture = Fixture::new();
    fixture.write("f.txt", b"abcdef");
    let first_call = json!({ "arguments": { "requests": [{ "path": "f.txt", "max_bytes": 1 }] } });
    let first = fixture.invoke(&first_call, None).await;
    let raw = first["next_cursor"].as_str().unwrap();
    let mut cursor: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(raw).unwrap()).unwrap();
    cursor["v"] = json!(1.0);
    cursor["request_index"] = json!(0.0);
    cursor["offset_bytes"] = json!(1.0);
    let altered = URL_SAFE_NO_PAD.encode(cursor.to_string());
    let call = json!({ "arguments": { "requests": [{ "path": "f.txt", "max_bytes": 1 }], "cursor": altered } });
    let result = fixture.invoke(&call, None).await;
    assert_eq!(result["files"][0]["content"], "b");
    assert_eq!(result["files"][0]["ok"], true);
    fixture.files.close().await;
}

#[cfg(unix)]
#[tokio::test]
async fn protected_ledger_symlink_alias_is_rejected_before_file_read() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    std::fs::create_dir(fixture.root.join(".project-ledger")).unwrap();
    std::fs::write(
        fixture.root.join(".project-ledger/secret.txt"),
        b"protected",
    )
    .unwrap();
    symlink(".project-ledger/secret.txt", fixture.root.join("alias.txt")).unwrap();
    let call = json!({ "arguments": { "requests": [{ "path": "alias.txt" }] } });
    let rust = fixture.invoke(&call, None).await;
    assert_eq!(rust["ok"], false);
    assert_eq!(rust["files"][0]["error"], "protected_path");
    fixture.files.close().await;
}

#[tokio::test]
async fn direct_rejected_absolute_paths_are_echoed_or_redacted_by_mode() {
    let fixture = Fixture::new();
    let outside = fixture
        .root
        .parent()
        .unwrap()
        .join("caller-supplied-outside.txt");
    let call = json!({ "arguments": { "requests": [{ "path": outside.to_string_lossy() }] } });
    for guided in [false, true] {
        let rust = fixture
            .capabilities
            .invoke(
                "read_file",
                CapabilityInvocation {
                    call: &call,
                    workspace_reference: None,
                    workspace_path: Some(&fixture.root),
                    butler_data: &fixture.root,
                    protected_ledger_roots: &[],
                    allowed_tools_and_effects: guided.then_some(&[]),
                    mutation_scope: None,
                    installation_root: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(
            rust["files"][0]["path"],
            if guided {
                ".".to_owned()
            } else {
                outside.to_string_lossy().into_owned()
            }
        );
    }
    fixture.files.close().await;
}
