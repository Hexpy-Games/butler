use butler_platform::secure_fs;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

static CHANGES: Mutex<()> = Mutex::new(());
pub(super) fn error(message: &str) -> std::io::Error {
    std::io::Error::other(message)
}
pub(super) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Clone)]
pub struct OutputStore {
    root: PathBuf,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Revision {
    pub revision: u64,
    pub entry: String,
    pub files: BTreeMap<String, String>,
    pub size_bytes: u64,
    pub created_at: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputKind {
    File,
    Site,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Output {
    pub kind: OutputKind,
    pub output_id: String,
    pub session_id: String,
    pub message_id: String,
    pub turn_id: String,
    pub title: String,
    pub revisions: Vec<Revision>,
}
pub struct PublishRequest {
    pub workspace: PathBuf,
    pub path: String,
    pub entry: Option<String>,
    pub title: String,
    pub session_id: String,
    pub message_id: String,
    pub turn_id: String,
}
impl OutputStore {
    pub fn new(data: &Path) -> Self {
        Self {
            root: data.join("outputs"),
        }
    }
    fn manifest(&self, id: &str) -> std::io::Result<PathBuf> {
        if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(error("invalid_output_id"));
        }
        Ok(self.root.join("manifests").join(format!("{id}.json")))
    }
    pub fn read(&self, id: &str) -> std::io::Result<Output> {
        serde_json::from_reader(secure_fs::open_read_no_follow(&self.manifest(id)?)?)
            .map_err(std::io::Error::other)
    }
    fn list(&self, session: &str) -> std::io::Result<Vec<Output>> {
        let dir = self.root.join("sessions").join(hash(session.as_bytes()));
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut outputs = Vec::new();
        for entry in std::fs::read_dir(dir)? {
            let id = entry?.file_name().to_string_lossy().into_owned();
            outputs.push(self.read(&id)?);
        }
        outputs.sort_by(|a, b| a.output_id.cmp(&b.output_id));
        Ok(outputs)
    }
    pub fn summaries(&self, session: &str) -> std::io::Result<Vec<super::OutputSummary>> {
        super::index::summaries(&self.root.join("index.sqlite"), session)
    }
    pub fn message_summaries(
        &self,
        session: &str,
        turns: &[String],
    ) -> std::io::Result<Vec<super::OutputSummary>> {
        super::index::messages(&self.root.join("index.sqlite"), session, turns)
    }
    pub fn publish(&self, request: PublishRequest) -> std::io::Result<(Output, usize)> {
        let _lock = CHANGES
            .lock()
            .map_err(|_| error("output_store_unavailable"))?;
        if request.title.chars().count() > 200 {
            return Err(error("output_title_too_long"));
        }
        let snapshot = super::snapshot::collect(&request)?;
        let id = self.publication_id(&request.session_id, &snapshot.source)?;
        let path = self.manifest(&id)?;
        let mut output = if path.exists() {
            self.read(&id)?
        } else {
            Output {
                kind: snapshot.kind,
                output_id: id.clone(),
                session_id: request.session_id.clone(),
                message_id: request.message_id.clone(),
                turn_id: request.turn_id.clone(),
                title: request.title.clone(),
                revisions: Vec::new(),
            }
        };
        let mut hashes = BTreeMap::new();
        let mut written = 0;
        for (name, bytes) in snapshot.files {
            let sha = hash(&bytes);
            let blob = self.blob(&sha)?;
            if !blob.exists() {
                secure_fs::create_private_dir_all(
                    blob.parent().ok_or_else(|| error("blob_parent"))?,
                )?;
                secure_fs::replace_private(
                    &blob,
                    |file| std::io::Write::write_all(file, &bytes),
                    |e| e,
                )?;
                written += 1;
            }
            hashes.insert(name, sha);
        }
        let revision = output.revisions.last().map_or(1, |r| r.revision + 1);
        output.title = request.title;
        output.message_id = request.message_id;
        output.turn_id = request.turn_id;
        output.revisions.push(Revision {
            revision,
            entry: snapshot.entry,
            files: hashes,
            size_bytes: snapshot.size,
            created_at: chrono::Utc::now().to_rfc3339(),
        });
        if output.revisions.len() > 5 {
            output.revisions.remove(0);
        }
        self.persist(&path, &output)?;
        Ok((output, written))
    }
    fn publication_id(&self, session: &str, source: &str) -> std::io::Result<String> {
        let generation = self.root.join("generations").join(hash(session.as_bytes()));
        let mut identity = format!("{session}\0{source}");
        if generation.exists() {
            let mut value = String::new();
            std::io::Read::read_to_string(
                &mut secure_fs::open_read_no_follow(&generation)?,
                &mut value,
            )?;
            identity.push('\0');
            identity.push_str(&value);
        }
        Ok(hash(identity.as_bytes()))
    }
    fn persist(&self, path: &Path, output: &Output) -> std::io::Result<()> {
        secure_fs::create_private_dir_all(path.parent().ok_or_else(|| error("manifest_parent"))?)?;
        let bytes = serde_json::to_vec(output).map_err(std::io::Error::other)?;
        secure_fs::replace_private(path, |file| std::io::Write::write_all(file, &bytes), |e| e)?;
        let index = self
            .root
            .join("sessions")
            .join(hash(output.session_id.as_bytes()));
        secure_fs::create_private_dir_all(&index)?;
        if !index.join(&output.output_id).exists() {
            secure_fs::replace_private(
                &index.join(&output.output_id),
                |_| Ok(()),
                |e: std::io::Error| e,
            )?;
        }
        super::index::save(&self.root.join("index.sqlite"), output)?;
        Ok(())
    }
    fn blob(&self, sha: &str) -> std::io::Result<PathBuf> {
        if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(error("invalid_blob"));
        }
        Ok(self.root.join("blobs").join(&sha[..2]).join(sha))
    }
    pub fn open_content(
        &self,
        id: &str,
        revision: u64,
        path: &str,
    ) -> std::io::Result<std::fs::File> {
        super::snapshot::relative(path)?;
        let output = self.read(id)?;
        let rev = output
            .revisions
            .iter()
            .find(|r| r.revision == revision)
            .ok_or_else(|| error("revision_not_found"))?;
        let sha = rev
            .files
            .get(path)
            .ok_or_else(|| error("output_file_not_found"))?;
        secure_fs::open_read_no_follow(&self.blob(sha)?)
    }
    /// Replayable ownership transfer. Keep source markers until every manifest and
    /// index reference has moved, so a crash at any write can replay the same set.
    pub fn transfer_session(&self, source: &str, target: &str) -> std::io::Result<()> {
        let _lock = CHANGES
            .lock()
            .map_err(|_| error("output_store_unavailable"))?;
        let source_dir = self.root.join("sessions").join(hash(source.as_bytes()));
        for mut output in self.list(source)? {
            output.session_id = target.to_owned();
            self.persist(&self.manifest(&output.output_id)?, &output)?;
        }
        super::index::transfer(&self.root.join("index.sqlite"), source, target)?;
        if source_dir.exists() {
            std::fs::remove_dir_all(source_dir)?;
        }
        // The archive id is a durable new publication generation. Replays write
        // the same value; deleting an archive cannot make new outputs reuse its URLs.
        let generations = self.root.join("generations");
        secure_fs::create_private_dir_all(&generations)?;
        secure_fs::replace_private(
            &generations.join(hash(source.as_bytes())),
            |file| std::io::Write::write_all(file, target.as_bytes()),
            |e| e,
        )?;
        Ok(())
    }
    /// Only session archive/delete runs GC; request paths never scan blobs.
    pub fn remove_session(&self, session: &str) -> std::io::Result<()> {
        let _lock = CHANGES
            .lock()
            .map_err(|_| error("output_store_unavailable"))?;
        for output in self.list(session)? {
            std::fs::remove_file(self.manifest(&output.output_id)?)?;
        }
        super::index::remove(&self.root.join("index.sqlite"), session)?;
        let index = self.root.join("sessions").join(hash(session.as_bytes()));
        if index.exists() {
            std::fs::remove_dir_all(index)?;
        }
        let manifests = self.root.join("manifests");
        if !manifests.exists() {
            return Ok(());
        }
        let mut live = std::collections::HashSet::new();
        for entry in std::fs::read_dir(manifests)? {
            let output: Output =
                serde_json::from_reader(secure_fs::open_read_no_follow(&entry?.path())?)
                    .map_err(std::io::Error::other)?;
            for rev in output.revisions {
                live.extend(rev.files.into_values());
            }
        }
        let blobs = self.root.join("blobs");
        if !blobs.exists() {
            return Ok(());
        }
        for shard in std::fs::read_dir(blobs)? {
            for blob in std::fs::read_dir(shard?.path())? {
                let blob = blob?;
                if !live.contains(&blob.file_name().to_string_lossy().into_owned()) {
                    std::fs::remove_file(blob.path())?;
                }
            }
        }
        Ok(())
    }
}
