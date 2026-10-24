use crate::models::ModelCatalog;

pub(super) fn assert_output_catalog() {
    let catalog = ModelCatalog::new().unwrap();
    let models = catalog.image_output_models();
    assert_eq!(models.len(), 6);
    for model in models {
        assert_eq!(
            model.output_modalities.as_deref(),
            Some(["image".to_owned()].as_slice())
        );
        assert!(!catalog.model_refs().contains(&model.model_ref));
        let mut capability = model.image_output.unwrap();
        capability.validate().unwrap();
        assert_ne!(capability.sizes, [] as [String; 0]);
        assert!(capability.max_input_images > 0);
        let cost = capability
            .pricing
            .estimated_cost(
                Some(1000),
                Some(2000),
                Some(3000),
                Some(&capability.default_quality),
                2,
            )
            .unwrap();
        assert!(cost > 0.0);
        let pricing = serde_json::to_value(&capability.pricing).unwrap();
        assert_eq!(pricing["as_of"], "2026-10-25");
        assert!(
            pricing["source_url"]
                .as_str()
                .unwrap()
                .starts_with("https://")
        );
        capability.default_quality = "absent".into();
        assert!(capability.validate().is_err());
    }
}
