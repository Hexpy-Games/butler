//! The source inventory captured as acceptance evidence: its records for
//! the source checks and its stored collections for the inventory hash.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use super::super::{invalid, io::sha256};
use super::RawSourceFact;
use crate::cognition::{CognitionCode, CognitionResult};
use crate::lenient::{Arg, Obj};

/// A source inventory (`butler.memory-source-inventory.v1`) captured as
/// acceptance evidence: the collections are read as records for the source
/// checks and hashed as stored for the inventory hash.
#[derive(Deserialize)]
pub(in crate::cognition::generation::qualification) struct EvidenceInventory {
    #[serde(default)]
    schema: Arg<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    origin: Option<Obj<InventoryOrigin>>,
    #[serde(default)]
    exclusions: Option<Box<RawValue>>,
    #[serde(default)]
    entries: InventoryRecords,
    #[serde(default)]
    typed: InventoryRecords,
    #[serde(default)]
    typed_lifecycle: Option<Box<RawValue>>,
    #[serde(default)]
    history: InventoryRecords,
}

/// Where the inventoried conversation sources came from.
#[derive(Deserialize)]
struct InventoryOrigin {
    #[serde(default)]
    version: Arg<String>,
}

/// One record collection of an inventory: the stored JSON the hash covers,
/// and its object items read as records.
#[derive(Default)]
struct InventoryRecords {
    stored: Option<Box<RawValue>>,
    records: Vec<InventoryRecord>,
}

impl<'de> Deserialize<'de> for InventoryRecords {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let stored = Option::<Box<RawValue>>::deserialize(deserializer)?;
        let records = match &stored {
            Some(raw) => serde_json::from_str::<RecordItems>(raw.get())
                .map_err(serde::de::Error::custom)?
                .0
                .into_iter()
                .flatten()
                .flatten()
                .collect(),
            None => Vec::new(),
        };
        Ok(Self { stored, records })
    }
}

/// The object items of a stored collection; a collection that is not an
/// array has none.
#[derive(Deserialize)]
#[serde(transparent)]
struct RecordItems(
    #[serde(deserialize_with = "crate::lenient::items")] Option<Vec<Option<InventoryRecord>>>,
);

/// The normalized inventory the memory inventory hash covers: `as_of` is
/// excluded, `origin.version` stands for the origin, and a missing or
/// `null` collection hashes as empty.
#[derive(Serialize)]
struct InventoryHashInput<'a> {
    #[serde(skip_serializing_if = "Arg::is_missing")]
    schema: &'a Arg<String>,
    origin_version: &'a Arg<String>,
    exclusions: Hashed<'a>,
    entries: Hashed<'a>,
    typed: Hashed<'a>,
    typed_lifecycle: Hashed<'a>,
    history: Hashed<'a>,
}

/// A hashed collection: its stored JSON, or an empty object or array.
enum Hashed<'a> {
    Stored(&'a RawValue),
    EmptyObject,
    EmptyArray,
}

impl<'a> Hashed<'a> {
    /// The stored collection, or `empty` when it was missing or `null`.
    fn of(stored: Option<&'a RawValue>, empty: Self) -> Self {
        stored.map_or(empty, Self::Stored)
    }
}

impl Serialize for Hashed<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::{SerializeMap, SerializeSeq};
        match self {
            Self::Stored(raw) => raw.serialize(serializer),
            Self::EmptyObject => serializer.serialize_map(Some(0))?.end(),
            Self::EmptyArray => serializer.serialize_seq(Some(0))?.end(),
        }
    }
}

impl EvidenceInventory {
    /// The memory inventory hash: SHA-256 of the ECMAScript `JSON.stringify`
    /// of the normalized inventory ([`InventoryHashInput`]).
    pub(in crate::cognition::generation::qualification) fn hash(&self) -> CognitionResult<String> {
        let missing = Arg::Missing;
        let input = InventoryHashInput {
            schema: &self.schema,
            origin_version: self
                .origin
                .as_ref()
                .map_or(&missing, |Obj(origin)| &origin.version),
            exclusions: Hashed::of(self.exclusions.as_deref(), Hashed::EmptyObject),
            entries: Hashed::of(self.entries.stored.as_deref(), Hashed::EmptyArray),
            typed: Hashed::of(self.typed.stored.as_deref(), Hashed::EmptyArray),
            typed_lifecycle: Hashed::of(self.typed_lifecycle.as_deref(), Hashed::EmptyArray),
            history: Hashed::of(self.history.stored.as_deref(), Hashed::EmptyArray),
        };
        // The JavaScript encoder works on a JSON tree; the collections are
        // only re-encoded here, never interpreted.
        let tree = serde_json::to_value(&input).map_err(|source| {
            invalid(CognitionCode::MemoryAcceptanceEvidenceInvalid).with_source(source)
        })?;
        let serialized = butler_core::json::stringify(&tree).map_err(|source| {
            invalid(CognitionCode::MemoryAcceptanceEvidenceInvalid).with_source(source)
        })?;
        Ok(sha256(serialized.as_bytes()))
    }

    /// Whether a conversation entry, typed record, or history row lists the
    /// source leaf with this revision and hash.
    pub(super) fn contains_raw_source_fact(&self, fact: &RawSourceFact<'_>) -> bool {
        let text = |value: &Option<String>, expected: &str| value.as_deref() == Some(expected);
        let lists = |values: &Option<Vec<String>>, expected: &str| {
            values.iter().flatten().any(|item| item == expected)
        };
        self.entries.records.iter().any(|entry| {
            text(&entry.episode_id, fact.episode_id)
                && text(&entry.revision, fact.revision)
                && lists(&entry.source_ids, fact.source_id)
                && lists(&entry.source_hashes, fact.source_hash)
        }) || self.typed.records.iter().any(|entry| {
            text(&entry.revision, fact.revision)
                && text(&entry.content_hash, fact.source_hash)
                && lists(&entry.typed_source_ids, fact.source_id)
        }) || self.history.records.iter().any(|entry| {
            text(&entry.source_ref, fact.source_id)
                && text(&entry.revision, fact.revision)
                && text(&entry.history_source_hash, fact.source_hash)
        })
    }
}

/// Lenient view of any inventory record: entries, typed records, and
/// history rows share this reader.
#[derive(Deserialize)]
struct InventoryRecord {
    #[serde(
        default,
        rename = "episodeId",
        deserialize_with = "crate::lenient::option"
    )]
    episode_id: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    revision: Option<String>,
    #[serde(
        default,
        rename = "sourceIds",
        deserialize_with = "crate::lenient::strings"
    )]
    source_ids: Option<Vec<String>>,
    #[serde(
        default,
        rename = "sourceHashes",
        deserialize_with = "crate::lenient::strings"
    )]
    source_hashes: Option<Vec<String>>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    content_hash: Option<String>,
    #[serde(
        default,
        rename = "source_ids",
        deserialize_with = "crate::lenient::strings"
    )]
    typed_source_ids: Option<Vec<String>>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    source_ref: Option<String>,
    #[serde(
        default,
        rename = "source_hash",
        deserialize_with = "crate::lenient::option"
    )]
    history_source_hash: Option<String>,
}
