//! Turn-owned reuse of exact request-digest bytes for unchanged plain messages.
use butler_turn::btcc::{BtccError, ModelRoundMessage, ModelRoundTool, ToolChoice};
use sha2::{Digest, Sha256};

use super::serialization::{MessageProjection, message_json, request_json};

const CACHE_BYTES: usize = 32 * 1024 * 1024;
const CACHE_ITEMS: usize = 4096;

#[derive(Default)]
pub(super) struct Cache {
    items: Vec<Option<(ModelRoundMessage, String)>>,
    bytes: usize,
    prefix: Vec<u8>,
    hash: Sha256,
}

impl Cache {
    pub(super) fn digest(
        &mut self,
        instructions: Option<&str>,
        tools: &[ModelRoundTool],
        choice: Option<ToolChoice>,
        messages: &[ModelRoundMessage],
    ) -> Result<String, BtccError> {
        let mut encoded = String::from("[");
        for (index, message) in messages.iter().enumerate() {
            if index > 0 {
                encoded.push(',');
            }
            if let Some(Some((source, bytes))) = self.items.get(index)
                && source == message
            {
                encoded.push_str(bytes);
                continue;
            }
            let bytes = message_json(message, MessageProjection::Exact)?;
            encoded.push_str(&bytes);
            self.retain(index, message, bytes);
        }
        encoded.push(']');
        let request = request_json(instructions, tools, choice, &encoded)?;
        // The final array/object delimiters change position on append. Hash
        // the stable prefix incrementally, then finalize a clone with them.
        let (prefix, suffix) = request.as_bytes().split_at(request.len() - 2);
        if prefix.len() > CACHE_BYTES {
            self.prefix = Vec::new();
            self.hash = Sha256::new();
            return Ok(super::serialization::digest(&request));
        }
        if !prefix.starts_with(&self.prefix) {
            self.prefix.clear();
            self.hash = Sha256::new();
        }
        self.hash.update(&prefix[self.prefix.len()..]);
        self.prefix.extend_from_slice(&prefix[self.prefix.len()..]);
        let mut hash = self.hash.clone();
        hash.update(suffix);
        Ok(format!("{:x}", hash.finalize()))
    }

    fn retain(&mut self, index: usize, message: &ModelRoundMessage, bytes: String) {
        if let Some(Some((_, old))) = self.items.get_mut(index) {
            self.bytes -= old.capacity() + old.len() * 2 + std::mem::size_of::<ModelRoundMessage>();
            self.items[index] = None;
        }
        // Value equality ignores object field order. Rich passthrough messages
        // always use the existing writer; plain DTO equality is exact.
        if message.provider_data.is_some()
            || !message.image_attachments.is_empty()
            || message.tool_calls.is_some()
            || index >= CACHE_ITEMS
        {
            return;
        }
        let retained =
            bytes.capacity() + bytes.len() * 2 + std::mem::size_of::<ModelRoundMessage>();
        if retained > CACHE_BYTES {
            return;
        }
        if self.bytes + retained > CACHE_BYTES {
            self.items.clear();
            self.bytes = 0;
        }
        self.items
            .resize_with(self.items.len().max(index + 1), || None);
        self.items[index] = Some((message.clone(), bytes));
        self.bytes += retained;
    }
}

#[cfg(test)]
pub(super) fn verify() {
    use super::tests::message;
    use butler_turn::btcc::ModelRoundRole;
    let mut cache = Cache::default();
    let mut messages = vec![message(ModelRoundRole::Tool, "escaped\n한글\"")];
    for step in 0..8 {
        match step {
            1 => messages.push(message(ModelRoundRole::User, "appended")),
            2 => messages[0].content = "latest".into(),
            3 => {
                messages[0].provider_data = Some(serde_json::from_str(r#"{"a":1,"b":2}"#).unwrap());
            }
            4 => {
                messages[0].provider_data = Some(serde_json::from_str(r#"{"b":2,"a":1}"#).unwrap());
            }
            5 => messages.truncate(1),
            6 => messages.clear(),
            _ => {}
        }
        for _ in 0..2 {
            let expected = super::serialization::request_for_messages(
                Some("instructions"),
                &[],
                None,
                &messages,
            )
            .unwrap();
            assert_eq!(
                cache
                    .digest(Some("instructions"), &[], None, &messages)
                    .unwrap(),
                super::serialization::digest(&expected)
            );
        }
    }
}
