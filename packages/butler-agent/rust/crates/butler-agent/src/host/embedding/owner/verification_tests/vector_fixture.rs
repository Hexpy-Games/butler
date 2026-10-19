//! A current semantic candidate with no lexical overlap with the race's query.
use arrow_array::{
    ArrayRef, FixedSizeListArray, Float32Array, RecordBatch, RecordBatchIterator, StringArray,
};
use arrow_schema::{DataType, Field, Schema};
use butler_memory::cognition::{
    EmbeddingIdentity, MemoryGenerationHandle, resolve_active_generation,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Arc};

pub(super) struct Fixture {
    pub root: PathBuf,
    pub generation: MemoryGenerationHandle,
    identity: EmbeddingIdentity,
}

fn hash(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

impl Fixture {
    pub(super) async fn new() -> Self {
        let root = std::env::temp_dir().join(format!("verification-{}", uuid::Uuid::new_v4()));
        let id = uuid::Uuid::new_v4().to_string();
        let memory = root.join("cognition/memory");
        let directory = memory.join("generations").join(&id);
        std::fs::create_dir_all(&directory).unwrap();
        let mut identity: EmbeddingIdentity = serde_json::from_value(json!({
            "schema": "butler.native-embedding-identity.v1", "model": "model", "runtime": "ort",
            "ort_wrapper_version": "2", "ort_api": 22, "runtime_build_info_sha256": "a".repeat(64),
            "tokenizer_runtime_version": "1", "tokenizer_asset_sha256": "b".repeat(64),
            "model_asset_sha256": "c".repeat(64), "preprocessing": "tokenizer-json-special-tokens-checked-v1",
            "pooling": "cls", "truncation": "strict-error-over-max", "normalize": true,
            "max_tokens": 8192, "dimension": 1024, "version": ""
        })).unwrap();
        identity.version = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&identity).unwrap())
        );
        std::fs::write(memory.join("active-generation.json"), json!({
            "schema":"butler.memory-active-generation.v2", "generation_id":id, "projection_mode":"running"
        }).to_string()).unwrap();
        std::fs::write(directory.join("manifest.json"), json!({
            "schema":"butler.memory-generation.v2", "generation_id":id, "format":"v2", "state":"active", "embedding":identity
        }).to_string()).unwrap();
        let generation = resolve_active_generation(&root, &Default::default()).unwrap();
        let fixture = Self {
            root,
            generation,
            identity,
        };
        fixture.seed().await;
        fixture
    }

    pub(super) fn response(&self, id: u64) -> String {
        json!({"id":id, "status":"embedding", "result":{"metadata":self.identity,
            "embeddings":[vector()], "token_counts":[4],
            "embedded_texts":["bike lock code"], "omitted_count":0}})
        .to_string()
    }

    async fn seed(&self) {
        let id = &self.generation.generation_id;
        let version = &self.identity.version;
        let text = "bicycle security combination";
        let chunk = hash(&json!(["embedding-chunk", "revision", 0, text]));
        let key = hash(&json!([
            "memory-vector",
            id,
            "node",
            "existing-entity",
            "revision",
            chunk,
            version
        ]));
        let connection = butler_platform::sqlite::open(&self.generation.graph_path).unwrap();
        connection.execute_batch("CREATE TABLE memory_chunks(memory_chunk_id TEXT,current_revision TEXT);
            CREATE TABLE memory_projection_jobs(job_id TEXT,episode_id TEXT,generation TEXT,revision TEXT);
            CREATE TABLE memory_vector_units(job_id TEXT,record_kind TEXT,owner_id TEXT,owner_revision TEXT,
                state TEXT,projection_text TEXT,source_ids_json TEXT,project_id TEXT,origin_kind TEXT,receipt_json TEXT);
            INSERT INTO memory_chunks VALUES('episode','revision');").unwrap();
        connection
            .execute(
                "INSERT INTO memory_projection_jobs VALUES('job','episode',?1,'revision')",
                [id],
            )
            .unwrap();
        connection.execute("INSERT INTO memory_vector_units VALUES('job','node','existing-entity','revision','complete',?1,'[]','','user_input',?2)",
            rusqlite::params![text, json!({"generation":id,"embedding_version":version,"vector_keys":[key]}).to_string()]).unwrap();
        drop(connection);
        let metadata = [
            ("vector_key", key.as_str()),
            ("generation", id),
            ("record_kind", "node"),
            ("owner_id", "existing-entity"),
            ("owner_revision", "revision"),
            ("source_revision", "revision"),
            ("embedding_chunk_id", &chunk),
            ("embedding_version", version),
            ("project_id", ""),
            ("origin_kind", "user_input"),
            ("source_kind", "conversation"),
            ("conversation_session_id", "session"),
            ("source_observed_at", "2026-01-01T00:00:00Z"),
            ("source_refs_json", "[]"),
        ];
        let mut fields = metadata
            .iter()
            .map(|(name, _)| Field::new(*name, DataType::Utf8, false))
            .collect::<Vec<_>>();
        let item = Arc::new(Field::new("item", DataType::Float32, true));
        fields.push(Field::new(
            "vector",
            DataType::FixedSizeList(item.clone(), 1024),
            false,
        ));
        let schema = Arc::new(Schema::new(fields));
        let mut columns = metadata
            .iter()
            .map(|(_, value)| Arc::new(StringArray::from(vec![*value])) as ArrayRef)
            .collect::<Vec<_>>();
        columns.push(Arc::new(FixedSizeListArray::new(
            item,
            1024,
            Arc::new(Float32Array::from(vector())),
            None,
        )));
        let batch = RecordBatch::try_new(schema.clone(), columns).unwrap();
        let db = lancedb::connect(self.generation.root.join("butler.lance").to_str().unwrap())
            .execute()
            .await
            .unwrap();
        db.create_table(
            "butler_memory",
            Box::new(RecordBatchIterator::new([Ok(batch)], schema))
                as Box<dyn arrow_array::RecordBatchReader + Send>,
        )
        .execute()
        .await
        .unwrap();
    }
}

fn vector() -> Vec<f32> {
    let mut vector = vec![0.0; 1024];
    vector[0] = 1.0;
    vector
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
