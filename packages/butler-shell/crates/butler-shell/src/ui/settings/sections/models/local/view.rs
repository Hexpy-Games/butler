//! The two sections of a Custom model's settings: `LocalModelApiSection` (with
//! `LocalModelConfigForm`) and `LocalModelInfoSection` (with `LocalModelDiscoveryForm` and
//! `LocalModelManualForm`).
use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::text::Input;
use butler_ds::ui::typo::Typo;
use gpui::{App, ClickEvent, Context, Entity, ParentElement as _, SharedString, Window};

use super::copy::{Words, get as words};
use super::form::Form;
use super::model::{Limits, Platform, token_window_label};
use super::{Busy, LocalModelSettings};
use crate::ui::Icon;
use crate::ui::settings::controls::{SettingsOption, SettingsSelect, SettingsSwitch};

type Page = Entity<LocalModelSettings>;

/// A handler that changes the page and redraws it.
fn edit<A: ?Sized + 'static>(
    this: &Page,
    apply: impl Fn(&mut LocalModelSettings, &A, &mut Context<LocalModelSettings>) + 'static,
) -> impl Fn(&A, &mut Window, &mut App) + 'static {
    let this = this.clone();
    move |arg, _, cx| {
        this.update(cx, |page, cx| {
            apply(page, arg, cx);
            cx.notify();
        });
    }
}

/// A one-line text field of the entry values.
fn text_field(
    this: &Page,
    id: &'static str,
    label: &'static str,
    value: &str,
    set: fn(&mut Form, String),
) -> SettingsField {
    let input = Input::new(id)
        .value(value.to_owned())
        .on_change(edit::<str>(this, move |page, text, _| {
            set(&mut page.form, text.to_owned());
        }));
    SettingsField::new(label).control(input)
}

fn platform_label(platform: Platform, words: &Words) -> &'static str {
    match platform {
        Platform::LlamaCpp => "llama.cpp",
        Platform::Ollama => "Ollama",
        Platform::LmStudio => "LM Studio",
        Platform::Custom => words.custom_openai_compatible,
    }
}

/// `LocalModelApiSection`
pub(super) fn api_section(page: &LocalModelSettings, this: &Page, cx: &App) -> SettingsSection {
    let words = words(cx);
    let mut section = SettingsSection::new(
        "local-model-api",
        SettingsSectionKind::Form,
        words.api_info_title,
    )
    .description(words.description)
    .holds_fields()
    .child(server_url_field(page, this, words))
    .child(api_key_field(page, this, words))
    .child(
        Button::new("local-model-advanced")
            .variant(Variant::Ghost)
            .size(Size::Sm)
            .icon_start(icon(Icon::SlidersHorizontal, IconSize::Md, Ds::get(cx)))
            .text(if page.advanced_open {
                words.hide_advanced
            } else {
                words.show_advanced
            })
            .on_click(edit::<ClickEvent>(this, |page, _, _| {
                page.advanced_open = !page.advanced_open;
            })),
    );
    if page.advanced_open {
        section = section.children(advanced_fields(page, this, words));
    }
    let mut discover = Button::new("local-model-discover")
        .variant(Variant::Outline)
        .icon_start(icon(Icon::RefreshCcw, IconSize::Md, Ds::get(cx)))
        .text(if page.busy == Some(Busy::Discover) {
            words.discovering
        } else {
            words.discover_models
        })
        .on_click(edit::<ClickEvent>(this, |page, _, cx| page.discover(cx)));
    if !page.can_discover() {
        discover = discover.disabled();
    }
    section.child(discover)
}

/// The API base URL; a failed discovery is its error.
// CARVE-OUT(focus): React focuses this field when the error appears; the page has no handle to
// the DS Input's focus.
fn server_url_field(page: &LocalModelSettings, this: &Page, words: &Words) -> SettingsField {
    let mut input = Input::new("local-model-server-url")
        .placeholder("http://localhost:8080")
        .value(page.form.server_url.clone())
        .on_change(edit::<str>(this, |page, text, _| {
            page.discovery_error = None;
            text.clone_into(&mut page.form.server_url);
        }));
    let mut field = SettingsField::new(words.server_url);
    if let Some(error) = page.discovery_error {
        input = input.invalid();
        field = field.error(error);
    }
    field.control(input)
}

/// The API key: untouched keeps the saved one, `Remove API key` clears it on save.
fn api_key_field(page: &LocalModelSettings, this: &Page, words: &Words) -> SettingsField {
    let key = page.form.api_key.as_deref();
    let placeholder = if key == Some("") {
        words.api_key_removed
    } else {
        words.api_key_placeholder
    };
    let input = Input::new("custom-model-api-key")
        .masked()
        .placeholder(placeholder)
        .value(key.unwrap_or_default().to_owned())
        .on_change(edit::<str>(this, |page, text, _| {
            page.form.api_key = Some(text.to_owned());
        }));
    let remove = Button::new("custom-model-api-key-remove")
        .variant(Variant::Ghost)
        .size(Size::Sm)
        .text(words.remove_api_key)
        .on_click(edit::<ClickEvent>(this, |page, _, _| {
            page.form.api_key = Some(String::new());
        }));
    SettingsField::new(words.api_key)
        .description(words.api_key_description)
        .control(input)
        .after_control(remove)
}

/// The API type (fixed) and the platform hint.
fn advanced_fields(page: &LocalModelSettings, this: &Page, words: &Words) -> [SettingsSelect; 2] {
    let api_type = SettingsSelect::new("local-model-api-type", words.api_type, "openai_compatible")
        .disabled(true)
        .description(words.api_description)
        .options(vec![SettingsOption::new(
            "openai_compatible",
            "OpenAI-compatible",
        )]);
    let options = Platform::ALL
        .into_iter()
        .map(|platform| SettingsOption::new(platform.wire(), platform_label(platform, words)))
        .collect();
    let platform = SettingsSelect::new(
        "local-model-platform",
        words.platform_hint,
        page.form.platform.wire(),
    )
    .options(options)
    .on_change(edit::<SharedString>(this, |page, value, _| {
        if let Some(platform) = Platform::from_wire(value) {
            page.form.platform = platform;
        }
    }));
    [api_type, platform]
}

/// `LocalModelInfoSection`
pub(super) fn info_section(page: &LocalModelSettings, this: &Page, cx: &App) -> SettingsSection {
    let words = words(cx);
    let mut section = SettingsSection::new(
        "local-model-info",
        SettingsSectionKind::Form,
        words.model_info_title,
    )
    .holds_fields();
    if !page.status.is_empty() {
        section = section.child(Typo::caption(page.status.clone()));
    }
    if page.form.has_unsaved(page.initial.as_ref()) {
        section = section.child(Typo::caption(words.unsaved_changes));
    }
    if let Some(discovered) = discovered_field(page, this, words) {
        section = section.child(discovered);
    }
    section
        .child(text_field(
            this,
            "local-model-id",
            words.model_id,
            &page.form.model_id,
            |form, text| form.model_id = text,
        ))
        .child(text_field(
            this,
            "local-model-display-name",
            words.display_name,
            &page.form.display_name,
            |form, text| form.display_name = text,
        ))
        .child(text_field(
            this,
            "local-model-context",
            words.max_context,
            &page.form.context,
            |form, text| form.context = text,
        ))
        .child(timeout_field(page, this, words, page.limits(cx)))
        .child(image_switch(page, this, words))
        .child(register_button(page, this, words, cx))
}

/// `LocalModelDiscoveryForm`: shown once discovery found models.
fn discovered_field(
    page: &LocalModelSettings,
    this: &Page,
    words: &Words,
) -> Option<SettingsSelect> {
    let models = page
        .discovery
        .as_ref()
        .filter(|models| !models.is_empty())?;
    let options = models
        .iter()
        .map(|model| {
            let window = token_window_label(model.context_window_tokens, words.context_unknown);
            SettingsOption::new(
                model.model_ref.clone(),
                format!("{} ({window})", model.name()),
            )
        })
        .collect();
    Some(
        SettingsSelect::new(
            "local-model-discovered",
            words.discovered_model,
            page.form.selected_ref.clone(),
        )
        .description(words.discovered_model_description)
        .options(options)
        .on_change(edit::<SharedString>(this, |page, value, _| {
            page.choose(value);
        })),
    )
}

/// The response time limit in seconds, against the agent's limits.
fn timeout_field(
    page: &LocalModelSettings,
    this: &Page,
    words: &Words,
    limits: Option<Limits>,
) -> SettingsField {
    let mut input = Input::new("local-model-response-timeout")
        .value(page.form.timeout.clone())
        .on_change(edit::<str>(this, |page, text, _| {
            text.clone_into(&mut page.form.timeout);
        }));
    let mut field = SettingsField::new(words.response_timeout)
        .description((words.timeout_description)(
            limits.map(|limits| limits.default / 1000.),
        ));
    if page.form.timeout_invalid(limits.as_ref()) {
        input = input.invalid();
        let range = limits.map(|limits| (limits.min / 1000., limits.max / 1000.));
        field = field.error((words.timeout_error)(range));
    }
    field.control(input)
}

fn image_switch(page: &LocalModelSettings, this: &Page, words: &Words) -> SettingsSwitch {
    let this = this.clone();
    SettingsSwitch::new("local-model-image-input", words.image_input)
        .checked(page.form.image_checked())
        .on_change(move |checked, _, cx| {
            this.update(cx, |page, cx| {
                page.form.set_image(checked);
                cx.notify();
            });
        })
}

fn register_button(page: &LocalModelSettings, this: &Page, words: &Words, cx: &App) -> Button {
    let label = if page.busy == Some(Busy::Register) {
        words.saving
    } else if page.form.is_editing() {
        words.save_model
    } else {
        words.register_model
    };
    let button = Button::new("local-model-register")
        .icon_start(icon(Icon::Save, IconSize::Md, Ds::get(cx)))
        .text(label)
        .on_click(edit::<ClickEvent>(this, |page, _, cx| page.register(cx)));
    if page.can_register(cx) {
        button
    } else {
        button.disabled()
    }
}
