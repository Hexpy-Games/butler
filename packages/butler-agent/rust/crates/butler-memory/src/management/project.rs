use super::*;
use serde_json::json;

impl MemoryManagement {
    /// Reads only the selected page and its indexed conversation rows.
    pub async fn project(
        &self,
        project_id: String,
        cancellation: CancellationToken,
    ) -> io::Result<Value> {
        let root = self.root.clone();
        let paths = self.paths.clone();
        tokio::task::spawn_blocking(move || {
            safety::validate(&root, &paths)?;
            safety::cancelled(&cancellation)?;
            let memory = paths.memory_root(&root);
            let mut view = json!({"project_id":project_id,"summary_bytes":null,"updated_at":null});
            if memory.join("active-generation.json").exists() {
                let active = safety::active(&root, &paths)?;
                let page = crate::cognition::StandingPage::Project(project_id.clone()).path(&active.root);
                crate::cognition::ensure_data_authority(&root, &[&page]).map_err(io::Error::other)?;
                let measured = measurement::files(&page, &cancellation)?;
                if page.try_exists()? && let Some(view) = view.as_object_mut() {
                    if let Some(bytes) = measured.bytes {
                        view.insert("summary_bytes".into(), json!(bytes));
                    } else {
                        view.remove("summary_bytes");
                    }
                    view.insert("updated_at".into(), json!(measured.latest));
                }
                let db = butler_platform::sqlite::open_with_flags(&active.graph_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(io::Error::other)?;
                let count: u64 = db.query_row("SELECT COUNT(*) FROM memory_chunks c WHERE c.project_id=?1 AND c.status='active' AND EXISTS(SELECT 1 FROM memory_chunk_sources s WHERE s.episode_id=c.memory_chunk_id AND s.revision=c.current_revision AND s.source_kind='conversation' AND s.origin_kind IN ('user_input','assistant_public'))", [&project_id], |r| r.get(0)).map_err(io::Error::other)?;
                if let Some(view) = view.as_object_mut() { view.insert("conversations".into(), json!(count)); }
            }
            Ok(view)
        }).await.map_err(io::Error::other)?
    }
}
