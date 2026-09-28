use super::*;

struct Fixture {
    data: PathBuf,
    connection: Connection,
}

impl Fixture {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let sequence = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let data = std::env::temp_dir().join(format!(
            "butler-ledger-binding-{}-{sequence}",
            std::process::id()
        ));
        std::fs::create_dir(&data).unwrap();
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE projects(id TEXT PRIMARY KEY,display_name TEXT,
            workspace_path TEXT,workspace_label TEXT,safe_path_label TEXT,ledger_project_id TEXT)",
            )
            .unwrap();
        Self { data, connection }
    }

    fn project(&self, id: &str, label: &str, existing: Option<&str>) -> PathBuf {
        let workspace = self.data.join("workspaces").join(id.replace('/', "_"));
        std::fs::create_dir_all(&workspace).unwrap();
        self.connection
            .execute(
                "INSERT INTO projects VALUES(?1,?1,?2,?1,?3,?4)",
                params![id, workspace.to_str().unwrap(), label, existing],
            )
            .unwrap();
        workspace
    }

    fn ledger(&self, id: &str) -> PathBuf {
        let root = self.data.join("project-ledger/projects").join(id);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("project.json"), "{}").unwrap();
        std::fs::write(root.join("ledger.jsonl"), "").unwrap();
        root
    }

    fn binding(&self, id: &str) -> String {
        self.connection
            .query_row(
                "SELECT ledger_project_id FROM projects WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .unwrap()
    }

    fn initialize(&self) {
        initialize(&self.connection, Some(&self.data)).unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _cleanup = std::fs::remove_dir_all(&self.data);
    }
}

/// Security boundary: symlink aliases of a project root share one physical
/// identity, and roots outside are rejected.
// test-category: security
#[cfg(unix)]
#[test]
fn symlink_aliases_share_one_physical_identity_and_outside_roots_are_rejected() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let original = fixture.ledger("original");
    symlink(
        &original,
        fixture.data.join("project-ledger/projects/alias"),
    )
    .unwrap();
    let workspace = fixture.project("a", "alias", None);
    std::fs::write(workspace.join("project.json"), r#"{"id":"original"}"#).unwrap();
    let outside = fixture.data.join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("project.json"), "{}").unwrap();
    std::fs::write(outside.join("ledger.jsonl"), "").unwrap();
    symlink(
        &outside,
        fixture.data.join("project-ledger/projects/escape"),
    )
    .unwrap();
    fixture.project("b", "escape", None);
    fixture.initialize();
    assert_eq!(fixture.binding("a"), "original");
    assert_eq!(fixture.binding("b"), "b");
}
