use super::EvidenceChunk;

const CHUNK_SIZE: usize = 1_500;
const CHUNK_OVERLAP: usize = 180;

pub(super) fn chunk_evidence(markdown: &str, title: Option<&str>, url: &str) -> Vec<EvidenceChunk> {
    let text = markdown.trim();
    let tables = super::table_context::contexts(text);
    let total = text.encode_utf16().count();
    let mut table_index = 0;
    let mut chunks = Vec::new();
    let mut offset = 0;
    while offset < total {
        while tables
            .get(table_index)
            .is_some_and(|table| table.end <= offset)
        {
            table_index += 1;
        }
        let header = tables
            .get(table_index)
            .filter(|table| {
                table.start < offset && offset >= table.header_end && offset < table.end
            })
            .map_or("", |table| table.header.as_str());
        // A header too large to share a source chunk stays in its original
        // chunks. Never let added context stop forward progress through rows.
        let header = if header.encode_utf16().count() + 2 < CHUNK_SIZE - CHUNK_OVERLAP {
            header
        } else {
            ""
        };
        let room = CHUNK_SIZE
            .saturating_sub(header.encode_utf16().count() + usize::from(!header.is_empty()) * 2);
        // Utf16Slice takes an end offset, not a length.
        let candidate = butler_core::json::Utf16Slice::new(text, offset, offset + room.max(1))
            .utf8_lossy()
            .into_owned();
        let candidate_units = candidate.encode_utf16().count();
        let end = offset.saturating_add(candidate_units);
        let mut end = end.min(total);
        if end < total
            && let Some(boundary) = candidate.rfind("\n\n")
        {
            let before = candidate[..boundary].encode_utf16().count();
            if before > CHUNK_SIZE * 45 / 100 {
                end = offset + before;
            }
        }
        let slice = butler_core::json::Utf16Slice::new(text, offset, end)
            .utf8_lossy()
            .into_owned();
        let chunk_text = if header.is_empty() {
            slice.trim().to_owned()
        } else {
            format!("{header}\n\n{}", slice.trim())
        };
        if !chunk_text.is_empty() {
            let index = chunks.len();
            let identity = format!("{url}:{index}:{}", super::utf16_prefix(&chunk_text, 160));
            chunks.push(EvidenceChunk {
                id: format!("ev_{}", super::simple_hash(&identity)),
                index,
                title: title.map(str::to_owned),
                url: url.into(),
                char_count: chunk_text.encode_utf16().count(),
                header_prefix: !header.is_empty(),
                units: super::super::read::passages::prepare(&chunk_text),
                text: chunk_text,
            });
        }
        if end >= total {
            break;
        }
        offset = end.saturating_sub(CHUNK_OVERLAP).max(offset + 1);
    }
    chunks
}
