pub(super) fn valid_category(value: &str) -> Option<&str> {
    matches!(
        value,
        "identity"
            | "cares"
            | "values"
            | "narrative"
            | "agency"
            | "epistemic_style"
            | "communication"
            | "affective_landscape"
            | "relationships"
            | "aesthetics"
            | "boundaries"
    )
    .then_some(value)
}
pub(super) fn valid_facet(value: Option<&str>) -> Option<&str> {
    value.filter(|value| {
        matches!(
            *value,
            "self_descriptions"
                | "roles"
                | "commitments"
                | "current_interests"
                | "enduring_interests"
                | "meaningful_objects"
                | "explicit_values"
                | "inferred_values"
                | "disliked_values"
                | "meaningful_events"
                | "turning_points"
                | "unresolved_threads"
                | "goals"
                | "active_projects"
                | "tensions"
                | "avoidance_patterns"
                | "how_the_user_thinks"
                | "evidence_preference"
                | "uncertainty_tolerance"
                | "correction_style"
                | "tone_preference"
                | "explanation_preference"
                | "emotional_mode"
                | "energizers"
                | "frustrations"
                | "comfort_patterns"
                | "important_people_or_groups"
                | "collaboration_preferences"
                | "social_boundaries"
                | "taste"
                | "anti_taste"
                | "quality_sense"
                | "privacy_rules"
                | "consent_required"
                | "sensitive_domains"
        )
    })
}
