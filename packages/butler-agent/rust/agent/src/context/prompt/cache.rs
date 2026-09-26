use serde::Serialize;
use serde::ser::{SerializeSeq, Serializer};
use sha2::{Digest, Sha256};
use std::io::Write;

use crate::btcc::ContextSection;
use crate::context::{ContextError, ContextResult};

pub(super) fn live_configuration_hash(sections: &[ContextSection]) -> ContextResult<String> {
    section_hash(sections)
}

fn section_hash(sections: &[ContextSection]) -> ContextResult<String> {
    let mut hash = Sha256::new();
    serde_json::to_writer(HashWriter(&mut hash), &SectionHashPayload { sections })
        .map_err(|error| ContextError::new("prompt_json_error", error.to_string()))?;
    Ok(format!("{:x}", hash.finalize())[..16].to_owned())
}

struct SectionHashPayload<'a> {
    sections: &'a [ContextSection],
}

impl Serialize for SectionHashPayload<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.sections.len()))?;
        for section in self.sections {
            sequence.serialize_element(&LiveHashSection {
                id: &section.id,
                title: &section.title,
                content: &section.content,
                projection_class: &section.projection_class,
                scope_kind: &section.scope_kind,
            })?;
        }
        sequence.end()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveHashSection<'a> {
    id: &'a str,
    title: &'a str,
    content: &'a str,
    projection_class: &'a str,
    scope_kind: &'a str,
}

struct HashWriter<'a>(&'a mut Sha256);

impl Write for HashWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
