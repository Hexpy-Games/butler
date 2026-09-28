//! `list_skills` lists metadata; naming one skill returns its instructions,
//! which is how the model reads a bundled instruction-only skill.

use super::*;
use crate::skills::Skills;

/// `list_skills` over the bundled skills and an empty data directory.
struct Bundled {
    data: PathBuf,
    capabilities: Capabilities,
}

impl Bundled {
    fn new() -> Self {
        let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../resources");
        let data = std::env::temp_dir().join(format!("butler-list-skills-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&data).unwrap();
        let capabilities = Capabilities::with_skills(
            Arc::new(WorkspaceFiles::new(1)),
            Arc::new(butler_turn::workspace::WorkspaceMutations::new()),
            Arc::new(Skills::new(resources, data.clone())),
        );
        Self { data, capabilities }
    }

    async fn list(&self, arguments: Value) -> Value {
        self.capabilities
            .invoke(
                "list_skills",
                CapabilityInvocation {
                    call: &json!({"arguments": arguments, "projectId": null}),
                    workspace_reference: None,
                    workspace_path: None,
                    butler_data: &self.data,
                    protected_ledger_roots: &[],
                    allowed_tools_and_effects: None,
                    mutation_scope: None,
                    installation_root: None,
                },
            )
            .await
            .unwrap()
    }
}

impl Drop for Bundled {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.data);
    }
}

#[tokio::test]
async fn a_named_skill_is_returned_with_its_instructions() {
    let bundled = Bundled::new();
    let listed = bundled.list(json!({})).await;
    assert_eq!(listed["ok"], true);
    let skills = listed["skills"].as_array().unwrap();
    let authoring = skills
        .iter()
        .find(|skill| skill["name"] == "wallpaper-authoring")
        .expect("the bundled wallpaper-authoring skill is listed");
    // The listing stays metadata only: bodies are read by name.
    assert!(authoring.get("instructions").is_none(), "{authoring}");
    assert!(
        skills
            .iter()
            .all(|skill| skill.get("instructions").is_none())
    );

    let named = bundled.list(json!({"name": " wallpaper-authoring "})).await;
    assert_eq!(named["ok"], true);
    let named_skills = named["skills"].as_array().unwrap();
    assert_eq!(named_skills.len(), 1, "{named}");
    assert_eq!(named_skills[0]["name"], "wallpaper-authoring");
    let instructions = named_skills[0]["instructions"].as_str().unwrap();
    assert!(
        instructions.contains("save_wallpaper_module"),
        "{instructions}"
    );
    assert_eq!(named_skills[0]["reporting"], authoring["reporting"]);
    // Any other instruction-bearing skill is readable the same way.
    let persona = bundled.list(json!({"name": "persona"})).await;
    assert!(
        persona["skills"][0]["instructions"]
            .as_str()
            .is_some_and(|text| !text.is_empty())
    );

    let unknown = bundled.list(json!({"name": "wallpaper"})).await;
    assert_eq!(unknown["ok"], false);
    assert_eq!(unknown["error"]["code"], "skill_not_found");
    assert_eq!(unknown["error"]["field"], "name");
    assert!(
        unknown["error"]["message"]
            .as_str()
            .unwrap()
            .contains("wallpaper")
    );
    assert!(
        unknown["error"]["allowed"]
            .as_array()
            .unwrap()
            .contains(&json!("wallpaper-authoring"))
    );
}

#[test]
fn the_definition_takes_an_optional_skill_name() {
    let definition = super::super::list_skills::definition();
    let parameters = &definition["parameters"];
    assert_eq!(parameters["required"], json!([]));
    assert_eq!(parameters["properties"]["name"]["type"], "string");
    let description = definition["description"].as_str().unwrap();
    assert!(description.contains("name"), "{description}");
    assert!(description.contains("instructions"), "{description}");
}
