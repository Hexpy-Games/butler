use super::*;

pub(super) fn assert_chats_reply_rules(assembler: &PromptAssembler, root: &Path) {
    std::fs::write(
        root.join("resources/prompts/chats.md"),
        "Chats reply rules\n",
    )
    .unwrap();
    let mut binding = binding(WorkspaceRole::Butler);
    let ordinary = assembler.static_context(&binding).unwrap();
    assert_eq!(ids(&ordinary), ["runtime-system-contract", "role"]);
    binding.session_id = "butler/app-general".into();
    let chats = assembler.static_context(&binding).unwrap();
    assert_eq!(
        ids(&chats),
        ["runtime-system-contract", "role", "chats-reply-rules"]
    );
    assert_eq!(&chats[..2], ordinary.as_slice());
    let rules = &chats[2];
    assert_eq!(rules.title, "Chats Reply Rules");
    assert_eq!(rules.content, "Chats reply rules");
    assert_eq!(rules.region.as_deref(), Some("static_context"));
    assert_eq!(rules.projection_class, "profile");
    assert_eq!(rules.scope_kind, "user");
    assert_eq!(assembler.static_context(&binding).unwrap(), chats);
    for role in [WorkspaceRole::Steward, WorkspaceRole::Worker] {
        binding.role = role;
        assert!(
            !assembler
                .static_context(&binding)
                .unwrap()
                .iter()
                .any(|section| section.id == "chats-reply-rules")
        );
    }
}
