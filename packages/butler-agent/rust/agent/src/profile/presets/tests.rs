use super::*;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("butler-rust-presets-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn locale(value: &serde_json::Value) -> PersonaLocale {
    match value.as_str().unwrap() {
        "en" => PersonaLocale::En,
        "ko" => PersonaLocale::Ko,
        value => panic!("unexpected golden locale: {value}"),
    }
}

#[test]
fn native_filesystem_presets_match_actual_bun_source() {
    let golden: serde_json::Value = serde_json::from_str(include_str!("bun-golden.json")).unwrap();
    let fixture = Fixture::new();
    let templates = fixture.0.join("resources/personas/templates");
    for (path, body) in golden["files"].as_object().unwrap() {
        let path = templates.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body.as_str().unwrap()).unwrap();
    }
    let owner = PersonaPresets::new(fixture.0.join("resources"));
    for case in golden["names"].as_array().unwrap() {
        assert_eq!(
            serde_json::to_value(safe_persona_preset_name(case["input"].as_str().unwrap()))
                .unwrap(),
            case["expected"]
        );
    }
    for case in golden["reads"].as_array().unwrap() {
        assert_eq!(
            serde_json::to_value(
                owner.read(locale(&case["locale"]), case["name"].as_str().unwrap())
            )
            .unwrap(),
            case["expected"]
        );
    }
    assert_eq!(
        serde_json::to_value(owner.list(PersonaLocale::Ko)).unwrap(),
        golden["koList"]
    );
    assert_eq!(
        serde_json::to_value(owner.list(PersonaLocale::En)).unwrap(),
        golden["enList"]
    );
}

#[test]
fn preset_owner_rereads_external_edits_from_one_resource_root() {
    let fixture = Fixture::new();
    let fallback = fixture.0.join("resources/personas/templates/en");
    fs::create_dir_all(&fallback).unwrap();
    fs::write(fallback.join("butler.md"), "First").unwrap();
    let owner = PersonaPresets::new(fixture.0.join("resources"));
    assert!(
        owner
            .read(PersonaLocale::Ko, "butler")
            .unwrap()
            .content
            .ends_with("First\n")
    );
    fs::write(fallback.join("butler.md"), "Second").unwrap();
    assert!(
        owner
            .read(PersonaLocale::En, "butler")
            .unwrap()
            .content
            .ends_with("Second\n")
    );
    fs::remove_file(fallback.join("butler.md")).unwrap();
    fs::write(fallback.join("guardian.md"), "Packaged").unwrap();
    let rows = owner.list(PersonaLocale::Ko);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].name, "guardian");
    assert_eq!(rows[0].locale, PersonaLocale::En);
}
