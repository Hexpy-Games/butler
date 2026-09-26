use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::btcc::{ContextAssembly, ContextSection};

pub(super) fn assembly_json(value: &ContextAssembly) -> Value {
    object([
        ("staticContext", sections(&value.static_context)),
        ("liveConfiguration", sections(&value.live_configuration)),
        ("runtimeState", sections(&value.runtime_state)),
        ("workingContext", sections(&value.working_context)),
        ("retrievedContext", sections(&value.retrieved_context)),
        ("currentInput", sections(&value.current_input)),
        ("references", Value::Array(value.references.clone())),
        ("liveConfigHash", value.live_config_hash.clone().into()),
    ])
}

pub(super) fn ids(sections: &[ContextSection]) -> Vec<&str> {
    sections.iter().map(|value| value.id.as_str()).collect()
}

pub(super) fn temp(name: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    std::env::temp_dir().join(format!(
        "butler-c3-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}

fn sections(values: &[ContextSection]) -> Value {
    Value::Array(values.iter().map(section_json).collect())
}

fn section_json(value: &ContextSection) -> Value {
    let mut output = Map::new();
    output.insert("id".into(), value.id.clone().into());
    output.insert("title".into(), value.title.clone().into());
    output.insert("content".into(), value.content.clone().into());
    if let Some(region) = &value.region {
        output.insert("region".into(), region.clone().into());
    }
    output.insert(
        "projectionClass".into(),
        value.projection_class.clone().into(),
    );
    output.insert("scopeKind".into(), value.scope_kind.clone().into());
    Value::Object(output)
}

fn object<const N: usize>(values: [(&str, Value); N]) -> Value {
    Value::Object(
        values
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    )
}
