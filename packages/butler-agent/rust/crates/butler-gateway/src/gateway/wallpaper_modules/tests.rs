use std::path::PathBuf;

use serde_json::{Value, json};

use super::*;

fn ui_modules() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../butler-app/client/ui/src/libs/design-system/blocks/Wallpaper/modules")
}

#[test]
fn builtins_are_every_valid_module_folder_of_the_ui_package() {
    let mut folders: Vec<String> = std::fs::read_dir(ui_modules())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.join("wallpaper.json").is_file())
        .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    folders.sort();
    assert!(folders.contains(&"butler.bloom".to_owned()), "{folders:?}");
    let bundled = bundled(BUNDLE);
    let names: Vec<_> = bundled.iter().map(|(folder, _)| folder.clone()).collect();
    assert_eq!(names, folders, "the bundle must follow the module folders");
    for (folder, module) in &bundled {
        let module = module
            .as_ref()
            .unwrap_or_else(|errors| panic!("{folder}/wallpaper.json: {errors:?}"));
        let text = std::fs::read_to_string(ui_modules().join(folder).join("wallpaper.json"));
        let authored: Value = serde_json::from_str(&text.unwrap()).unwrap();
        assert_eq!(module.manifest, authored, "{folder}");
    }
    let listed: Vec<_> = WallpaperModules::builtin()
        .builtin_entries(false)
        .iter()
        .map(|manifest| manifest["id"].as_str().unwrap().to_owned())
        .collect();
    let selectable: Vec<_> = folders
        .into_iter()
        .filter(|folder| folder != ENGINE_IMAGE_MODULE)
        .collect();
    assert_eq!(listed, selectable);
}

fn module(id: &str, image: &str, params: &Value) -> Value {
    json!({
        "id": id, "name": {"en": "Test", "ko": "테스트"}, "version": "1.0.0",
        "engine": 1, "motion": "static", "image": image, "params": params
    })
}

fn label() -> Value {
    json!({"en": "Label", "ko": "라벨"})
}

fn params() -> Value {
    json!([
        {"key": "speed", "label": label(), "type": "number", "min": 0.05, "max": 0.2, "step": 0.05, "default": 0.1,
         "control": "shuffle"},
        {"key": "mono", "label": label(), "type": "boolean", "default": false},
        {"key": "season", "label": label(), "type": "enum",
         "options": ["spring", {"value": "autumn", "label": {"en": "Autumn", "ko": "가을"}}], "default": "spring"},
        {"key": "base", "label": label(), "type": "color", "default": "#ffffff"},
        {"key": "colors", "label": label(), "type": "palette", "size": 2, "default": ["#000000", "#ffffff"],
         "presets": {"dusk": {"light": ["#111111", "#222222"], "dark": ["#333333", "#444444"]}}}
    ])
}

fn registry() -> WallpaperModules {
    WallpaperModules::default().with([
        manifest::validate(module("test.live", "optional", &params())).unwrap(),
        manifest::validate(module("test.plain", "none", &json!([]))).unwrap(),
        manifest::validate(module("test.filter", "required", &json!([]))).unwrap(),
    ])
}

fn errors(manifest: Value) -> Vec<String> {
    manifest::validate(manifest).unwrap_err()
}

#[test]
fn manifests_follow_contract_v1() {
    let valid = manifest::validate(module("test.live", "optional", &params())).unwrap();
    assert_eq!(valid.id, "test.live");
    assert_eq!(valid.image, manifest::ImageInput::Optional);
    let mut broken = module("Test", "sometimes", &params());
    broken["engine"] = json!(2);
    broken["version"] = json!("1.0");
    broken["timePeriod"] = json!(0);
    let found = errors(broken);
    for expected in ["id:", "image:", "engine:", "version:", "timePeriod:"] {
        assert!(
            found.iter().any(|error| error.starts_with(expected)),
            "{expected} {found:?}"
        );
    }
    let cases = [
        (
            json!([{"key": "a", "label": label(), "type": "number", "min": 1, "max": 0, "step": 1, "default": 1}]),
            "params[0]: min must be below max",
        ),
        (
            json!([{"key": "a", "label": label(), "type": "number", "min": 0, "max": 1, "step": 0.1, "default": 2}]),
            "params[0].default: must be a number in [0, 1]",
        ),
        (
            json!([{"key": "a", "label": label(), "type": "enum", "options": [], "default": "x"}]),
            "params[0].options: 1 to 8 unique values",
        ),
        (
            json!([{"key": "a", "label": label(), "type": "palette", "size": 7, "default": []}]),
            "params[0].size: must be an integer in [2, 6]",
        ),
        (
            json!([{"key": "a", "label": label(), "type": "palette", "size": 2, "default": ["#000000", "#ffffff"],
                 "presets": {"p": {"light": ["#000000"], "dark": ["#000000", "#ffffff"]}}}]),
            "params[0].presets.p.light: must be 2 #RRGGBB colors",
        ),
        (
            json!([{"key": "a", "label": label(), "type": "boolean", "default": false, "control": "shuffle"}]),
            "params[0].control: only number params take a control",
        ),
        (
            json!([{"key": "a", "label": label(), "type": "gradient", "default": 0}]),
            "params[0].type: unknown gradient",
        ),
        (
            json!([{"key": "A", "label": label(), "type": "boolean", "default": false}]),
            "params[0].key: must match ^[a-z][A-Za-z0-9]{0,23}$",
        ),
        (
            json!([{"key": "a", "label": label(), "type": "boolean", "default": true},
                {"key": "a", "label": label(), "type": "boolean", "default": true}]),
            "params[1].key: duplicate a",
        ),
    ];
    for (params, expected) in cases {
        let found = errors(module("test.case", "none", &params));
        assert!(
            found.iter().any(|error| error == expected),
            "{expected}: {found:?}"
        );
    }
    let nine: Vec<_> = (0..9)
        .map(|n| json!({"key": format!("p{n}"), "label": label(), "type": "boolean", "default": true}))
        .collect();
    assert!(
        errors(module("test.case", "none", &json!(nine))).contains(&"params: at most 8".into())
    );
}

#[test]
fn later_modules_never_shadow_earlier_ones_or_add_the_engine_image_module() {
    let builtin = WallpaperModules::builtin();
    let bloom = builtin.get("butler.bloom").unwrap().clone();
    let impostor = manifest::validate(module("butler.bloom", "none", &json!([]))).unwrap();
    let image = manifest::validate(module(ENGINE_IMAGE_MODULE, "required", &json!([]))).unwrap();
    let user = manifest::validate(module("user.rain", "none", &json!([]))).unwrap();
    let joined = builtin.with([impostor, image, user]);
    assert_eq!(joined.get("butler.bloom"), Some(&bloom));
    assert!(joined.get(ENGINE_IMAGE_MODULE).is_none());
    assert!(joined.get("user.rain").is_some());
    assert!(builtin.get(ENGINE_IMAGE_MODULE).is_none());
}

fn rejected(result: Result<(), AppWallpaperRejection>) -> (String, String, Option<Value>) {
    let rejection = result.unwrap_err();
    assert_eq!(
        (rejection.status, rejection.code.as_str()),
        (400, "wallpaper_invalid")
    );
    (
        rejection.field,
        rejection.message,
        rejection.allowed.map(|allowed| *allowed),
    )
}

#[test]
fn parameter_values_are_checked_per_kind_naming_the_field_and_what_is_allowed() {
    let modules = registry();
    let live =
        |params: Value| modules.check_live(&json!({"module": "test.live", "params": params}));
    live(json!({"speed": 0.2, "mono": true, "season": "autumn", "base": "#A0b0C0", "colors": "dusk"}))
        .unwrap();
    live(json!({"colors": ["#000000", "#123456"]})).unwrap();
    let (field, message, allowed) = rejected(live(json!({"warmth": 1})));
    assert_eq!(field, "source.params.warmth");
    assert_eq!(
        allowed,
        Some(json!(["speed", "mono", "season", "base", "colors"]))
    );
    assert!(
        message.contains("Allowed: speed, mono, season, base, colors"),
        "{message}"
    );
    let (field, message, allowed) = rejected(live(json!({"speed": 0.5})));
    assert_eq!(field, "source.params.speed");
    assert_eq!(
        message,
        "source.params.speed must be a number from 0.05 to 0.2."
    );
    assert_eq!(
        allowed,
        Some(json!({"min": 0.05, "max": 0.2, "step": 0.05}))
    );
    let (field, _, allowed) = rejected(live(json!({"season": "winter"})));
    assert_eq!(
        (field.as_str(), allowed),
        ("source.params.season", Some(json!(["spring", "autumn"])))
    );
    let (field, _, _) = rejected(live(json!({"mono": "yes"})));
    assert_eq!(field, "source.params.mono");
    let (field, _, _) = rejected(live(json!({"base": "red"})));
    assert_eq!(field, "source.params.base");
    let (field, message, _) = rejected(live(json!({"colors": ["#000000"]})));
    assert_eq!(field, "source.params.colors");
    assert!(
        message.contains("preset name (dusk) or a list of 2"),
        "{message}"
    );
    let dark = json!({"module": "test.live", "paramsDark": {"speed": "fast"}});
    assert_eq!(
        rejected(modules.check_live(&dark)).0,
        "source.paramsDark.speed"
    );
    let (field, _, _) = rejected(live(json!(["speed"])));
    assert_eq!(field, "source.params");
}

#[test]
fn live_sources_and_image_filters_follow_the_module_image_input() {
    let modules = registry();
    let (field, message, allowed) =
        rejected(modules.check_live(&json!({"module": "test.missing"})));
    assert_eq!(field, "source.module");
    assert_eq!(allowed, Some(json!(["test.live", "test.plain"])));
    assert!(
        message.contains("names no installed wallpaper module"),
        "{message}"
    );
    let (field, _, allowed) = rejected(modules.check_live(&json!({"module": "test.filter"})));
    assert_eq!(
        (field.as_str(), allowed),
        ("source.module", Some(json!(["test.live", "test.plain"])))
    );
    modules
        .check_filter(&json!({"module": "test.filter"}))
        .unwrap();
    modules
        .check_filter(&json!({"module": "test.live", "params": {"mono": true}}))
        .unwrap();
    let (field, message, allowed) =
        rejected(modules.check_filter(&json!({"module": "test.plain"})));
    assert_eq!(field, "source.filter.module");
    assert!(message.contains("does not take an image"), "{message}");
    assert_eq!(allowed, Some(json!(["test.live", "test.filter"])));
    let filter = json!({"module": "test.live", "params": {"speed": 9}});
    assert_eq!(
        rejected(modules.check_filter(&filter)).0,
        "source.filter.params.speed"
    );
}

#[test]
fn drawing_fields_are_optional_and_each_rule_names_its_field() {
    let mut scene = module("test.scene", "required", &params());
    scene["overlay"] = json!(true);
    scene["pixelRatio"] = json!("device");
    scene["imageDim"] = json!("noDarkStep");
    scene["defaultImage"] = json!("photo.jpg");
    scene["sceneTone"] = json!({"param": "mono", "darkPhases": [[0, 0.25], [0.75, 1]]});
    let scene = manifest::validate(scene).unwrap();
    assert!(scene.overlay);
    // A photo module is a live wallpaper over its own image, and a filter.
    let modules = WallpaperModules::default().with([scene.clone()]);
    let source = json!({"module": "test.scene", "params": {"mono": true, "season": "autumn"}});
    modules.check_live(&source).unwrap();
    modules.check_filter(&source).unwrap();
    let mut entry = json!({});
    describe_for_agent(&mut entry, &scene);
    assert_eq!(
        entry,
        json!({"uses": ["live", "filter"], "photo": true, "realtimeParam": "mono"})
    );
    let phases = json!([[0, 0.1], [0.2, 0.3], [0.4, 0.5], [0.6, 0.7], [0.8, 0.9]]);
    let ranges = "sceneTone.darkPhases: 1 to 4 [start, end) ranges with 0 <= start < end <= 1";
    let cases = [
        ("overlay", json!("yes"), "overlay: must be a boolean"),
        (
            "pixelRatio",
            json!("retina"),
            "pixelRatio: must be default or device",
        ),
        (
            "imageDim",
            json!(0.2),
            "imageDim: must be auto, noDarkStep or none",
        ),
        (
            "defaultImage",
            json!("../photo.jpg"),
            "defaultImage: must be a .jpg",
        ),
        (
            "defaultImage",
            json!("photo.gif"),
            "defaultImage: must be a .jpg",
        ),
        ("sceneTone", json!("night"), "sceneTone: must be an object"),
        (
            "sceneTone",
            json!({"param": "speed", "darkPhases": [[0, 0.2]]}),
            "sceneTone.param: must name a boolean param",
        ),
        (
            "sceneTone",
            json!({"param": "mono", "darkPhases": []}),
            ranges,
        ),
        (
            "sceneTone",
            json!({"param": "mono", "darkPhases": [[0.5, 0.5]]}),
            ranges,
        ),
        (
            "sceneTone",
            json!({"param": "mono", "darkPhases": phases}),
            ranges,
        ),
    ];
    for (field, value, expected) in cases {
        let mut manifest = module("test.case", "optional", &params());
        manifest[field] = value;
        let found = errors(manifest);
        assert!(
            found.iter().any(|error| error.starts_with(expected)),
            "{expected}: {found:?}"
        );
    }
    let mut plain = module("test.case", "none", &params());
    plain["defaultImage"] = json!("photo.jpg");
    let expected = "defaultImage: needs image optional or required".to_owned();
    assert!(errors(plain).contains(&expected));
}
