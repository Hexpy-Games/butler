use super::*;

pub(super) fn verify(snapshot: &ContextBudgetSnapshot<'_>) {
    for text in ["한글💡\\\"".repeat(400), "a b c ".repeat(1000)] {
        for limit in [0.0, 10.0, 32.0, 100.0] {
            let clipped = trim_text_to_token_budget(snapshot, &text, limit, true, None).unwrap();
            assert!(
                snapshot
                    .estimate(
                        butler_models::models::TokenEstimateInput::Text(&clipped),
                        None
                    )
                    .unwrap()
                    .tokens
                    <= limit
            );
            assert_eq!(
                clipped,
                trim_text_to_token_budget(snapshot, &text, limit, true, None).unwrap()
            );
        }
    }

    deterministic_tool_boundaries();
    let messages = (0..20)
        .map(|index| {
            message(
                &format!("m{index}"),
                None,
                index,
                ConversationRole::User,
                &"한글💡 facts ".repeat(200),
            )
        })
        .collect::<Vec<_>>();
    let mut a = Vec::new();
    let mut b = Vec::new();
    let first = super::super::compaction::algorithm::build_summary(
        &messages, snapshot, 200.0, 100.0, &mut a,
    )
    .unwrap();
    let second = super::super::compaction::algorithm::build_summary(
        &messages, snapshot, 200.0, 100.0, &mut b,
    )
    .unwrap();
    assert_eq!(first, second);
    assert_eq!(a, b);
    assert!(
        snapshot
            .estimate(
                butler_models::models::TokenEstimateInput::Text(&first),
                None
            )
            .unwrap()
            .tokens
            <= 100.0
    );
}

fn deterministic_tool_boundaries() {
    // Group B crosses the starting cut. Expanding B then pulls A across it.
    // Iterating A before B without a second pass leaves A split.
    let mut messages = (0..10)
        .map(|i| {
            message(
                &format!("m{i}"),
                None,
                i,
                ConversationRole::Assistant,
                "history",
            )
        })
        .collect::<Vec<_>>();
    for (index, id, kind) in [
        (1, "a", ConversationPartKind::ToolCall),
        (4, "b", ConversationPartKind::ToolCall),
        (6, "a", ConversationPartKind::ToolResult),
        (9, "b", ConversationPartKind::ToolResult),
    ] {
        messages[index].parts[0].kind = kind;
        messages[index].parts[0].tool_call_id = Some(id.into());
    }
    for _ in 0..100 {
        let window = super::super::compaction::algorithm::compaction_window(&messages, 2);
        assert_eq!(window.to_summarize.len(), 1);
        assert_eq!(window.preserved.len(), 9);
    }
}
