use butler_e2e::e2e::HarnessError;
use butler_memory::cognition::{
    CONTINUITY_HEADER as HEADER, CONTINUITY_INSTRUCTIONS as INSTRUCTIONS,
    continuity_prompt as prompt,
};
use butler_turn::conversation::ContinuityTurn;
use sha2::{Digest, Sha256};

// test-category: format-pin
#[test]
fn summary_instructions_and_header_are_pinned() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    assert_eq!(
        format!("{:x}", Sha256::digest(INSTRUCTIONS)),
        "c8d7396966684c2fbb948778b4ee1bc2cd4a7496060bb165de05f610c43a4119"
    );
    assert_eq!(
        HEADER,
        "Summary of earlier turns of this chat, kept by Butler. Facts here were established in this chat; read_conversation_context returns exact wording."
    );
    Ok(())
}

// test-category: format-pin
#[test]
fn summary_input_keeps_the_full_previous_summary_and_terminal_status() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let turns = vec![
        ContinuityTurn {
            number: 7,
            status: "complete".into(),
            user: "A fact".into(),
            hook_context: String::new(),
            answer: "An answer".into(),
            tools: vec!["read_file".into()],
        },
        ContinuityTurn {
            number: 8,
            status: "cancelled".into(),
            user: "A correction".into(),
            hook_context: String::new(),
            answer: String::new(),
            tools: vec![],
        },
    ];
    assert_eq!(
        prompt("## Facts and entities\nExisting fact", &turns),
        "Current summary:\n## Facts and entities\nExisting fact\n\nNext turns, oldest first:\n[turn 7, complete]\nuser: A fact\nbutler: An answer\ntools used: read_file\n[turn 8, cancelled]\nuser: A correction\nbutler (cancelled, not established): (no answer)"
    );
    assert_eq!(
        prompt("", &[]),
        "Current summary:\n(none)\n\nNext turns, oldest first:"
    );
    for status in ["failed", "cancelled", "interrupted"] {
        let turn = ContinuityTurn {
            number: 1,
            status: status.into(),
            user: "Request".into(),
            hook_context: String::new(),
            answer: "Unestablished answer".into(),
            tools: vec![],
        };
        assert!(prompt("", &[turn]).contains(&format!(
            "butler ({status}, not established): Unestablished answer"
        )));
    }
    Ok(())
}

// test-category: format-pin
#[test]
fn direct_recall_before_asking_sentence_is_pinned() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let prefixes: serde_json::Value = serde_json::from_str(include_str!(
        "../../../butler-turn/src/btcc/guided_turn/phase/instruction-prefixes.json"
    ))
    .unwrap();
    assert!(prefixes["phase_minimal|butler|direct"].as_str().unwrap().contains("Look up needed current/external/workspace/attachment/memory/project facts, including what the user said earlier, with tools instead of guessing, disclaiming or asking: read_conversation_context for this chat, recall_memory for earlier chats and durable facts, list_conversation_sessions then read_conversation_session for referenced chats; ask only if lookup finds nothing."));
    Ok(())
}

use butler_turn::conversation::omitted_history_notice as omitted_notice;

// test-category: format-pin
#[test]
fn omitted_notice_is_not_a_turn_header_and_only_varies_with_window_start()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    assert_eq!(
        omitted_notice(12),
        "Older turns omitted: 12 earlier turns of this chat are not shown below. Session Continuity summarizes them; read_conversation_context returns their exact text. Look things up there before asking the user about anything they may already have said."
    );
    assert!(!omitted_notice(12).starts_with("turn "));
    Ok(())
}

// test-category: pure-logic
#[test]
fn wide_characters_cost_one_token_and_other_characters_keep_utf16_estimates()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    use butler_models::models::{ModelCatalog, ModelCatalogSnapshotInput, TokenEstimateInput};
    let catalog = ModelCatalog::new().unwrap();
    let snapshot = catalog
        .snapshot(
            ModelCatalogSnapshotInput {
                configured_local: vec![],
                extra_models: vec![],
                registered_models: vec![],
                credential_views: vec![],
                default_model_ref: None,
                generated_at: "now".into(),
            },
            &butler_core::locale::LocaleCollation::new("en-US").unwrap(),
        )
        .unwrap();
    for (model, divisor, english) in [
        ("anthropic/claude-sonnet-5", 3.8_f64, 2632.0),
        ("google/gemini-3.8-flash", 4.0_f64, 2500.0),
    ] {
        let estimate = |text: &str| {
            catalog
                .estimate_tokens(&snapshot, TokenEstimateInput::Text(text), Some(model))
                .unwrap()
                .tokens
        };
        assert_eq!(estimate(&"가".repeat(10_000)), 10_000.0);
        assert_eq!(estimate(&"a".repeat(10_000)), english);
        for code in [
            0x1100, 0x11ff, 0x3000, 0x30ff, 0x3130, 0x318f, 0x3400, 0x4dbf, 0x4e00, 0x9fff, 0xa960,
            0xa97f, 0xac00, 0xd7af, 0xd7b0, 0xd7ff, 0xf900, 0xfaff, 0xff00, 0xffef, 0x20000,
            0x2ffff,
        ] {
            let text = char::from_u32(code).unwrap().to_string().repeat(100);
            assert_eq!(estimate(&text), 100.0);
        }
        assert_eq!(estimate("가a😀"), (1.0 + 3.0 / divisor).ceil());
    }
    Ok(())
}
