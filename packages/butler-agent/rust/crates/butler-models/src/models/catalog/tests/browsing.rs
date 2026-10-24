use super::*;

pub(super) fn assert_resolution_rules() {
    let catalog = catalog();
    for provider in &catalog.providers {
        assert!(
            provider.presets.browsing.is_none(),
            "no acceptance results yet"
        );
    }
    let find = |id| lookup::find_model_metadata(Some(id), &catalog.models).unwrap();
    let register = |mut model: ModelProviderMetadata, credential: &str| {
        model.registered = Some(true);
        model.credential_id = Some(credential.into());
        model.auth_type = Some(ProviderAuthMethod::ApiKey);
        model
    };
    let conversation = register(find("opencode-go/glm-5.3"), "account-a");
    let sibling = register(find("opencode-go/glm-5.3-flash"), "account-a");
    let other_family = register(find("opencode-go/gpt-6-luna"), "account-a");
    let preset = ModelPreset {
        model: other_family.model_ref.clone(),
        effort: ReasoningEffort::Low,
    };
    let resolve = |models: &[ModelProviderMetadata], multi, preset| {
        resolve_browsing_model(
            &conversation,
            ReasoningEffort::High,
            models,
            multi,
            preset,
            None,
        )
    };
    let chosen = resolve(
        &[other_family.clone(), sibling.clone()],
        true,
        Some(&preset),
    );
    assert_eq!(chosen.rule, BrowsingRule::FamilySibling);
    assert_eq!(chosen.model, sibling.model_ref);
    assert_eq!(chosen.effort, sibling.default_reasoning_effort);
    let chosen = resolve(std::slice::from_ref(&other_family), true, Some(&preset));
    assert_eq!(chosen.rule, BrowsingRule::ProviderPreset);
    assert_eq!(chosen.model, preset.model);
    assert_eq!(chosen.effort, preset.effort);
    for models in [vec![], vec![other_family.clone()], vec![sibling.clone()]] {
        let chosen = resolve(&models, false, None);
        assert_eq!(chosen.rule, BrowsingRule::Conversation);
        assert_eq!(chosen.model, conversation.model_ref);
        assert_eq!(chosen.effort, ReasoningEffort::High);
    }
    for mut bad in [sibling.clone(), other_family.clone()] {
        bad.credential_id = Some("account-b".into());
        assert_eq!(
            resolve(&[bad], true, Some(&preset)).rule,
            BrowsingRule::Conversation
        );
    }
    for kind in 0..6 {
        let mut bad = sibling.clone();
        match kind {
            0 => bad.provider_id = "other-provider".into(),
            1 => bad.enabled = Some(false),
            2 => bad.registered = Some(false),
            3 => bad.runtime_supported = false,
            4 => bad.auth_type = Some(ProviderAuthMethod::ChatGptOauth),
            _ => bad.api_base_url = Some("https://other.invalid".into()),
        }
        assert_eq!(resolve(&[bad], true, None).rule, BrowsingRule::Conversation);
    }
    let planning = ModelPreset {
        model: sibling.model_ref.clone(),
        effort: sibling.default_reasoning_effort,
    };
    let resolve_presets = |models: &[ModelProviderMetadata], browsing| {
        resolve_browsing_model(
            &conversation,
            ReasoningEffort::High,
            models,
            false,
            browsing,
            Some(&planning),
        )
    };
    let chosen = resolve_presets(&[sibling.clone(), other_family.clone()], None);
    assert_eq!(chosen.rule, BrowsingRule::PlanningPreset);
    assert_eq!(
        (chosen.model, chosen.effort),
        (planning.model.clone(), planning.effort)
    );
    assert_eq!(
        serde_json::to_value(chosen.rule).unwrap(),
        "planning_preset"
    );
    let chosen = resolve_presets(&[sibling.clone(), other_family.clone()], Some(&preset));
    assert_eq!(chosen.rule, BrowsingRule::ProviderPreset);
    assert_eq!(
        (chosen.model, chosen.effort),
        (preset.model.clone(), preset.effort)
    );
    for kind in 0..10 {
        let mut bad = sibling.clone();
        match kind {
            0 => bad.credential_id = Some("account-b".into()),
            1 => bad.provider_id = "other-provider".into(),
            2 => bad.enabled = Some(false),
            3 => bad.registered = Some(false),
            4 => bad.runtime_supported = false,
            5 => bad.auth_type = Some(ProviderAuthMethod::ChatGptOauth),
            6 => bad.api_base_url = Some("https://other.invalid".into()),
            7 => bad.server_url = Some("https://other.invalid".into()),
            8 => {
                bad.extensions
                    .insert("auth_profile".into(), serde_json::json!("other"));
            }
            _ => bad.reasoning_efforts.clear(),
        }
        assert_eq!(
            resolve_presets(&[bad], None).rule,
            BrowsingRule::Conversation
        );
    }
    let mut unsupported_effort = other_family;
    unsupported_effort.reasoning_efforts = vec![ReasoningEffort::High];
    assert_eq!(
        resolve(&[unsupported_effort], true, Some(&preset)).rule,
        BrowsingRule::Conversation
    );
    let mut oauth = conversation.clone();
    oauth.auth_type = Some(ProviderAuthMethod::ChatGptOauth);
    oauth.credential_id = None;
    oauth
        .extensions
        .insert("auth_profile".into(), serde_json::json!("a"));
    let mut other_oauth = sibling;
    other_oauth.auth_type = oauth.auth_type;
    other_oauth.credential_id = None;
    other_oauth
        .extensions
        .insert("auth_profile".into(), serde_json::json!("b"));
    assert_eq!(
        resolve_browsing_model(
            &oauth,
            ReasoningEffort::High,
            &[other_oauth],
            true,
            None,
            None
        )
        .rule,
        BrowsingRule::Conversation
    );
    assert_tier_schemes(&catalog);
}

fn assert_tier_schemes(catalog: &StaticCatalog) {
    for model in &catalog.models {
        if let Some((tier, _)) =
            super::super::presets::infer_tier_and_version(&model.provider_id, &model.model_id)
        {
            assert_eq!(model.tier, Some(tier), "{}", model.model_ref);
        }
    }
    for (provider, model, tier) in [
        ("google", "gemini-5.2-argon", ModelTier::Flagship),
        ("google", "gemini-5.2-flash", ModelTier::Balanced),
        ("google", "gemini-5.2-flash-lite", ModelTier::Efficient),
        ("zai", "glm-6.1-flash", ModelTier::Efficient),
        ("opencode-go", "glm-6.1-flash", ModelTier::Efficient),
        ("opencode-go", "deepseek-v5.1-flash", ModelTier::Efficient),
    ] {
        assert_eq!(
            super::super::presets::infer_tier_and_version(provider, model)
                .unwrap()
                .0,
            tier
        );
    }
    assert!(super::super::presets::infer_tier_and_version("zai", "glm-6.1").is_none());
}
