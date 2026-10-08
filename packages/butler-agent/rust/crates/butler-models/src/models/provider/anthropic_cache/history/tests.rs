#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "format-pin assertions"
)]
use super::*;

// test-category: format-pin
#[test]
fn history_blocks_preserve_bytes_and_previous_breakpoint_within_lookback() {
    let mut previous: Vec<Value> = Vec::new();
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
        assert_eq!(blocks.len(), count + 1);
        if count > 1 {
            assert_eq!(&blocks[..previous.len()], previous.as_slice());
            assert_eq!(blocks.len() - previous.len(), 1);
        }
        previous = blocks;
    }
}
