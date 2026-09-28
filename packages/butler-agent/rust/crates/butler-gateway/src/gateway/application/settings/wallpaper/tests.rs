use serde_json::{Value, json};

use super::{from_legacy, project, project_view, sanitize, view};
use crate::gateway::GatewayApplicationError;

const COLORS: [&str; 6] = [
    "#112233", "#445566", "#778899", "#aabbcc", "#ddeeff", "#010203",
];

fn rejection(value: &Value) -> String {
    match sanitize(value) {
        Err(GatewayApplicationError::Public {
            status: 400,
            code,
            message,
            ..
        }) if code == "settings_wallpaper_invalid" => message,
        other => panic!("expected settings_wallpaper_invalid for {value}, got {other:?}"),
    }
}

fn assert_rejected(value: &Value, path: &str) {
    let message = rejection(value);
    assert!(
        message.contains(path),
        "message for {value} should name {path}: {message}"
    );
}

fn live(module: &str) -> Value {
    json!({"source": {"kind": "live", "module": module}})
}

fn live_params(params: Value) -> Value {
    let mut value = live("butler.bloom");
    value["source"]["params"] = params;
    value
}

fn image(overrides: &Value) -> Value {
    let mut source = json!({
        "kind": "image", "asset": "wp_0123abcd", "fit": "cover", "dim": 0.25, "blur": 0
    });
    for (key, value) in overrides.as_object().unwrap() {
        if value.is_null() {
            source.as_object_mut().unwrap().remove(key);
        } else {
            source[key] = value.clone();
        }
    }
    json!({ "source": source })
}

#[test]
fn accepts_every_source_kind_and_partial_settings() {
    let accepted = [
        json!({"source": {"kind": "none"}, "motion": "auto", "pauseOnBattery": false}),
        live("butler.washi"),
        live("myorg9.rain-window.v2"),
        live_params(json!({
            "colors": ["#AABBCC", "#001122"],
            "speed": 0.1,
            "grain": 3,
            "fold": true,
            "palette": "aurora",
        })),
        json!({"source": {
            "kind": "live", "module": "butler.bloom",
            "params": {"colors": "monochrome"}, "paramsDark": {"colors": COLORS}
        }}),
        image(&json!({})),
        image(&json!({"fit": "contain", "dim": 1, "blur": 1})),
        image(&json!({"filter": {"module": "butler.riso", "params": {"offset": 0.5}}})),
        image(&json!({"filter": {"module": "butler.washi", "paramsDark": {"fold": false}}})),
        json!({"motion": "paused"}),
        json!({"pauseOnBattery": true}),
    ];
    for value in accepted {
        assert_eq!(sanitize(&value).unwrap(), value);
    }
}

#[test]
fn rejects_malformed_settings_with_the_offending_path() {
    assert_rejected(&json!("bloom"), "wallpaper");
    assert_rejected(&json!({}), "wallpaper");
    assert_rejected(&json!({"theme": "bloom"}), "wallpaper.theme");
    assert_rejected(&json!({"motion": "slow"}), "wallpaper.motion");
    assert_rejected(
        &json!({"pauseOnBattery": "yes"}),
        "wallpaper.pauseOnBattery",
    );
    assert_rejected(&json!({"source": "none"}), "wallpaper.source");
    assert_rejected(&json!({"source": {}}), "wallpaper.source.kind");
    assert_rejected(
        &json!({"source": {"kind": "video"}}),
        "wallpaper.source.kind",
    );
    assert_rejected(
        &json!({"source": {"kind": "none", "module": "butler.bloom"}}),
        "wallpaper.source.module",
    );
    assert_rejected(
        &json!({"source": {"kind": "live"}}),
        "wallpaper.source.module",
    );
    assert_rejected(
        &json!({"source": {"kind": "live", "module": "butler.bloom", "speed": 1}}),
        "wallpaper.source.speed",
    );
}

#[test]
fn rejects_module_ids_outside_the_contract() {
    let too_long = format!("butler.{}", "a".repeat(58));
    assert_eq!(too_long.len(), 65);
    for module in [
        json!("bloom"),
        json!("Butler.bloom"),
        json!("butler..bloom"),
        json!(".butler.bloom"),
        json!("butler.bloom."),
        json!("my-org.bloom"),
        json!("butler.bl_oom"),
        json!("butler.blöom"),
        json!(too_long),
        json!(7),
    ] {
        assert_rejected(
            &json!({"source": {"kind": "live", "module": module}}),
            "wallpaper.source.module",
        );
    }
    let longest = format!("butler.{}", "a".repeat(57));
    assert!(sanitize(&live(&longest)).is_ok());
    assert_rejected(
        &image(&json!({"filter": {"module": "Riso"}})),
        "wallpaper.source.filter.module",
    );
}

#[test]
fn rejects_param_maps_outside_the_contract() {
    let too_long = "s".repeat(25);
    for key in [
        "Speed",
        "1speed",
        "sp_eed",
        "speed-fast",
        "",
        too_long.as_str(),
    ] {
        assert_rejected(&live_params(json!({ key: 1 })), "wallpaper.source.params");
    }
    assert!(sanitize(&live_params(json!({ "s".repeat(24): 1 }))).is_ok());
    let seventeen = (0..17)
        .map(|index| (format!("p{index}"), json!(index)))
        .collect::<serde_json::Map<_, _>>();
    assert_rejected(
        &live_params(Value::Object(seventeen)),
        "wallpaper.source.params",
    );
    let sixteen = (0..16)
        .map(|index| (format!("p{index}"), json!(index)))
        .collect::<serde_json::Map<_, _>>();
    assert!(sanitize(&live_params(Value::Object(sixteen))).is_ok());
    assert_rejected(&live_params(json!([1])), "wallpaper.source.params");
    assert_rejected(
        &json!({"source": {"kind": "live", "module": "butler.bloom", "paramsDark": {"x": null}}}),
        "wallpaper.source.paramsDark.x",
    );
    for value in [
        json!(null),
        json!({"nested": 1}),
        json!("x".repeat(65)),
        json!([]),
        json!(vec!["#112233"; 7]),
        json!(["#11223"]),
        json!(["#1122334"]),
        json!(["112233"]),
        json!(["#11223g"]),
        json!([1, 2]),
    ] {
        assert_rejected(
            &live_params(json!({ "colors": value })),
            "wallpaper.source.params.colors",
        );
    }
    assert!(sanitize(&live_params(json!({"label": "x".repeat(64)}))).is_ok());
    assert!(sanitize(&live_params(json!({"colors": vec!["#112233"; 6]}))).is_ok());
    assert_rejected(
        &image(&json!({"filter": {"module": "butler.riso", "params": {"Bad": 1}}})),
        "wallpaper.source.filter.params",
    );
}

#[test]
fn rejects_image_sources_outside_the_contract() {
    let long_asset = format!("wp_{}", "a".repeat(65));
    for asset in [
        json!("wp_short"),
        json!("wp_0123ABCD"),
        json!("img_0123abcd"),
        json!("wp_0123abcd/.."),
        json!(long_asset),
        json!(null),
    ] {
        assert_rejected(&image(&json!({ "asset": asset })), "wallpaper.source.asset");
    }
    assert!(sanitize(&image(&json!({"asset": format!("wp_{}", "a".repeat(64))}))).is_ok());
    assert_rejected(&image(&json!({"fit": "fill"})), "wallpaper.source.fit");
    assert_rejected(&image(&json!({"fit": null})), "wallpaper.source.fit");
    for (field, value) in [
        ("dim", json!(1.5)),
        ("dim", json!(-0.1)),
        ("dim", json!("0.5")),
        ("dim", json!(null)),
        ("blur", json!(2)),
        ("blur", json!(true)),
    ] {
        assert_rejected(
            &image(&json!({ field: value })),
            &format!("wallpaper.source.{field}"),
        );
    }
    assert_rejected(
        &image(&json!({"filter": "butler.riso"})),
        "wallpaper.source.filter",
    );
    assert_rejected(
        &image(&json!({"filter": {"module": "butler.riso", "kind": "live"}})),
        "wallpaper.source.filter.kind",
    );
    assert_rejected(
        &image(&json!({"module": "butler.riso"})),
        "wallpaper.source.module",
    );
}

#[test]
fn legacy_keys_map_to_sources() {
    let colors = COLORS.map(String::from);
    assert_eq!(
        from_legacy("none", "aurora", &colors),
        json!({"kind": "none"})
    );
    assert_eq!(
        from_legacy("silk", "aurora", &colors),
        json!({"kind": "live", "module": "butler.silk"})
    );
    assert_eq!(
        from_legacy("bloom", "aurora", &colors),
        json!({"kind": "live", "module": "butler.bloom", "params": {"colors": "aurora"}})
    );
    assert_eq!(
        from_legacy("bloom", "custom", &colors),
        json!({"kind": "live", "module": "butler.bloom", "params": {"colors": COLORS}})
    );
}

#[test]
fn view_prefers_a_valid_stored_setting_and_fills_defaults() {
    let legacy = json!({"kind": "live", "module": "butler.silk"});
    let derived = json!({"source": legacy, "motion": "auto", "pauseOnBattery": false});
    assert_eq!(view(None, legacy.clone()), derived);
    assert_eq!(
        view(Some(&json!({"source": {"kind": "live"}})), legacy.clone()),
        derived
    );
    assert_eq!(view(Some(&json!("none")), legacy.clone()), derived);
    assert_eq!(
        view(Some(&json!({"motion": "paused"})), legacy.clone()),
        json!({"source": legacy, "motion": "paused", "pauseOnBattery": false})
    );
    let stored = json!({"source": {"kind": "none"}, "motion": "auto", "pauseOnBattery": true});
    assert_eq!(view(Some(&stored), legacy), stored);
}

fn settings(theme: &str, preset: &str, wallpaper: &Value) -> Value {
    json!({
        "main_screen_theme": theme,
        "main_screen_theme_preset": preset,
        "main_screen_theme_custom_colors": COLORS,
        "wallpaper": wallpaper,
    })
}

/// The projection of `patch` onto `current`, as the settings projection does
/// for the legacy keys before it resolves `wallpaper`.
fn projected(current: &Value, patch: &Value) -> Value {
    let mut output = current.clone();
    for (key, value) in patch.as_object().unwrap() {
        output[key] = value.clone();
    }
    project(current, patch, &mut output);
    output
}

#[test]
fn legacy_patch_rederives_the_source_and_keeps_motion() {
    let current = settings(
        "bloom",
        "aurora",
        &json!({
            "source": {"kind": "live", "module": "butler.bloom", "params": {"colors": "aurora"}},
            "motion": "paused", "pauseOnBattery": true
        }),
    );
    let output = projected(&current, &json!({"main_screen_theme": "silk"}));
    assert_eq!(
        output["wallpaper"],
        json!({
            "source": {"kind": "live", "module": "butler.silk"},
            "motion": "paused", "pauseOnBattery": true
        })
    );
    let output = projected(&current, &json!({"main_screen_theme_preset": "custom"}));
    assert_eq!(
        output["wallpaper"]["source"],
        json!({"kind": "live", "module": "butler.bloom", "params": {"colors": COLORS}})
    );
}

#[test]
fn legacy_patch_never_overwrites_a_chosen_wallpaper() {
    let explicit = json!({
        "source": {"kind": "live", "module": "butler.washi"},
        "motion": "auto", "pauseOnBattery": false
    });
    let current = settings("bloom", "aurora", &explicit);
    for patch in [
        json!({"main_screen_theme": "bloom"}),
        json!({"main_screen_theme": "silk"}),
        json!({"main_screen_theme_preset": "custom"}),
        json!({"main_screen_theme_custom_colors": vec!["#000000"; 6]}),
        json!({"translucent_sidebar": false}),
    ] {
        assert_eq!(
            projected(&current, &patch)["wallpaper"],
            explicit,
            "{patch}"
        );
    }
}

#[test]
fn wallpaper_patch_is_the_source_of_truth() {
    let current = settings(
        "bloom",
        "aurora",
        &json!({
            "source": {"kind": "live", "module": "butler.bloom", "params": {"colors": "aurora"}},
            "motion": "auto", "pauseOnBattery": true
        }),
    );
    let output = projected(
        &current,
        &json!({"main_screen_theme": "silk", "wallpaper": {"source": {"kind": "none"}}}),
    );
    assert_eq!(output["main_screen_theme"], "silk");
    assert_eq!(
        output["wallpaper"],
        json!({"source": {"kind": "none"}, "motion": "auto", "pauseOnBattery": true})
    );
    let output = projected(
        &current,
        &json!({"main_screen_theme": "none", "wallpaper": {"motion": "paused"}}),
    );
    assert_eq!(
        output["wallpaper"],
        json!({
            "source": {"kind": "live", "module": "butler.bloom", "params": {"colors": "aurora"}},
            "motion": "paused", "pauseOnBattery": true
        })
    );
}

#[test]
fn settings_updated_payload_carries_wallpaper_and_custom_colors() {
    let wallpaper = json!({"source": {"kind": "none"}, "motion": "auto", "pauseOnBattery": false});
    let projection = settings("bloom", "custom", &wallpaper);
    let payload = super::super::update::event_payload(&projection);
    let settings = payload["settings"].as_object().unwrap();
    assert_eq!(settings["wallpaper"], wallpaper);
    assert_eq!(settings["main_screen_theme_custom_colors"], json!(COLORS));
    assert_eq!(settings["main_screen_theme_preset"], "custom");
}

#[test]
fn project_view_keeps_a_valid_value_and_otherwise_inherits() {
    let none = json!({"kind": "none"});
    assert_eq!(project_view(Some(&none)), none);
    let invalid = [
        json!("global"),
        json!({"kind": "video"}),
        live("butler.bloom"),
    ];
    for stored in invalid.iter().map(Some).chain([None]) {
        assert_eq!(project_view(stored), json!("inherit"), "{stored:?}");
    }
}
