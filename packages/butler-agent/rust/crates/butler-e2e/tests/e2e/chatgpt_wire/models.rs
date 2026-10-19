use super::*;
pub(super) async fn unreadable_registration(s: &Scenario) -> Result<(), HarnessError> {
    let path = s.sandbox.data.join("auth/chatgpt.json");
    let saved = std::fs::read(&path)?;
    std::fs::remove_file(&path)?;
    std::fs::create_dir(&path)?;
    let catalog = s.gw.get("/model-catalog").await?;
    std::fs::remove_dir(&path)?;
    std::fs::write(&path, saved)?;
    assert_eq!(catalog.status, 200);
    let providers = catalog.data()["providers"].as_array().unwrap();
    assert!(providers.len() > 1);
    assert!(
        providers
            .iter()
            .find(|p| p["provider_id"] == "openai")
            .unwrap()["chatgpt_plan_models"]
            .is_null()
    );
    let registered = catalog.data()["registered_models"].as_array().unwrap();
    assert_ne!(registered.as_slice(), &[] as &[Value]);
    for model in registered {
        assert_eq!(
            model["availability"],
            if model["auth_type"] == "chatgpt_oauth" {
                "sign_in_required"
            } else {
                "ready"
            }
        );
    }
    Ok(())
}
