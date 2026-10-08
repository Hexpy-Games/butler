#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "format-pin assertions"
)]
use super::*;

pub(in crate::models::provider) fn history_chunks_preserve_bytes_and_previous_breakpoint_within_lookback()
 {
    let mut previous = String::new();
    let mut frozen = Vec::new();
    for count in 1..=66 {
        let turns = (0..count)
            .map(|index| {
                format!("turn ct_{index} status complete\nuser: 한글 é 😀 {index}\nbutler: done")
            })
            .collect::<Vec<_>>()
            .join("\n");
        let stable = "docs\n\n## Conversation history\n\n";
        let text = format!("{stable}{turns}\n\n## Current turn context\nrequest");
        let diagnostics = json!({"inputSections":[
            {"id":"docs","bytes":4},
            {"id":"history-heading","bytes":"## Conversation history".len()},
            {"id":"recent-conversation","bytes":turns.len()}
        ]});
        let boundary = stable.len() + turns.len() + 2;
        let (blocks, end) = blocks(&text, boundary, Some(&diagnostics));
        let strings = blocks
            .iter()
            .map(|b| b["text"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(format!("{}{}", strings.concat(), &text[end..]), text);
        assert_eq!(strings[0], stable);
        assert!(strings.len() <= 1 + count / CHUNK_TURNS + CHUNK_TURNS + RECENT_TURNS);
        if count > 1 {
            let mut prefix = String::new();
            let position = strings
                .iter()
                .position(|block| {
                    prefix.push_str(block);
                    prefix == previous
                })
                .expect("previous breakpoint must remain a block boundary");
            assert!(strings.len() - position <= 20);
        }
        let chunks = count.saturating_sub(RECENT_TURNS) / CHUNK_TURNS;
        let formed = strings[1..=chunks]
            .iter()
            .map(|s| (*s).to_owned())
            .collect::<Vec<_>>();
        assert!(
            formed.starts_with(&frozen),
            "formed chunk changed at {count}"
        );
        frozen = formed;
        previous = strings.concat();
    }
}
