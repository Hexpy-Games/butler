//! Backup models (`BackupModelsSummary.tsx`, `BackupModelsSettings.tsx`, `BackupModelCards.tsx`,
//! `BackupModelPicker.tsx`): a summary line, and under Edit the switch, the add picker and the
//! ordered cards.
use butler_ds::ui::blocks::filtered_select_popover::{Filter, FilteredSelectPopover, Group, Item};
use butler_ds::ui::blocks::settings_field::{ControlWidth, SettingsField, SettingsFieldGroup};
use butler_ds::ui::blocks::settings_section::{
    SettingsSection, SettingsSectionKind, SettingsSectionState,
};
use butler_ds::ui::blocks::sortable_card_list::{SortableCardItem, SortableCardList};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::collapsible::Collapsible;
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{AlignSelf, Cross, Space, Stack, StackItem, WithItem as _};
use butler_ds::ui::popover::{MenuSize, Popover, PopoverContent};
use butler_ds::ui::tooltip::Align;
use gpui::{AnyElement, Context, IntoElement as _, ParentElement as _, SharedString, Window};

use super::RootPage;
use super::copy::Words;
use super::data::{
    Fallback, MAX_BACKUP_MODELS, RegisteredModel, Slice, add_backup, fallback_patch, registered,
    selectable,
};
use crate::ui::Icon;
use crate::ui::composer::menus::token_window_label;
use crate::ui::i18n::composer::menus::copy as composer_copy;
use crate::ui::settings::controls::{SettingsSwitch, provider_mark};
use crate::ui::settings::{Save, SectionCtx};

/// The editor's own state: open, and the picker's search and provider filter.
pub(super) struct Ui {
    editing: bool,
    search: SharedString,
    provider: SharedString,
}

impl Default for Ui {
    fn default() -> Self {
        Self {
            editing: false,
            search: SharedString::default(),
            provider: "all".into(),
        }
    }
}

/// "Off", or the backup models in the order they take over.
fn summary(fallback: &Fallback, models: &[RegisteredModel], words: &Words) -> String {
    if !fallback.enabled {
        return words.backup_off.to_owned();
    }
    if fallback.models.is_empty() {
        return words.backup_empty.to_owned();
    }
    let names: Vec<&str> = fallback
        .models
        .iter()
        .map(|model_ref| {
            models
                .iter()
                .find(|model| model.model_ref == *model_ref)
                .map_or(model_ref.as_str(), RegisteredModel::name)
        })
        .collect();
    names.join(" → ")
}

/// The ordered cards (`BackupModelCards`).
fn cards(
    ctx: &SectionCtx,
    fallback: &Fallback,
    models: &[RegisteredModel],
    saving: bool,
    lang: Lang,
    words: &Words,
) -> SortableCardList {
    let items = fallback.models.iter().filter_map(|model_ref| {
        let model = models.iter().find(|model| model.model_ref == *model_ref)?;
        // CARVE-OUT(G-logo): the card's leading mark is the server icon; React shows the
        // provider's logo (D1's `leading` takes an icon, not an element).
        Some(
            SortableCardItem::new(model.model_ref.clone(), model.name().to_owned())
                .label(model.name().to_owned())
                .description(format!("{} · {}", model.provider_label, model.model_ref))
                .meta(token_window_label(
                    model.context_window_tokens,
                    composer_copy(lang),
                ))
                .leading(Icon::Server),
        )
    });
    let (reorder, remove) = (ctx.clone(), ctx.clone());
    let (order, kept) = (fallback.clone(), fallback.clone());
    SortableCardList::new("settings-backup-model-list", items.collect())
        .disabled(saving)
        .empty_message(words.backup_empty)
        .on_reorder(move |ids, _, cx| {
            let models: Vec<String> = ids.iter().map(ToString::to_string).collect();
            reorder.save(fallback_patch(order.enabled, &models), Save::default(), cx);
        })
        .on_remove(move |id, _, cx| {
            let models: Vec<String> = kept
                .models
                .iter()
                .filter(|model| model.as_str() != &**id)
                .cloned()
                .collect();
            remove.save(fallback_patch(kept.enabled, &models), Save::default(), cx);
        })
}

impl RootPage {
    /// The `backup-models` section.
    pub(super) fn backup_section(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> SettingsSection {
        let words = super::copy::get(cx);
        let state = self.ctx.state.read(cx);
        let slice: Option<Slice> = state.slice();
        let models = registered(state.catalog());
        let saving = state.saving();
        let section = SettingsSection::new(
            "backup-models",
            SettingsSectionKind::Form,
            words.backup_models_section,
        );
        let Some(slice) = slice else {
            return section.state(SettingsSectionState::Loading);
        };
        let editing = self.backup.editing;
        let toggle = Button::new("backup-models-edit")
            .size(Size::Sm)
            .variant(Variant::Outline)
            .text(if editing {
                words.backup_done
            } else {
                words.backup_edit
            })
            .on_click(cx.listener(|this, _, _, cx| {
                this.backup.editing = !this.backup.editing;
                cx.notify();
            }));
        let summary_field = SettingsField::new(summary(&slice.model_fallback, &models, words))
            .description(words.backup_summary_description)
            .control(toggle);
        let fields = self.editor_fields(&slice, &models, saving, window, cx);
        section.child(summary_field).child(
            Collapsible::new("backup-models-editor", editing)
                .child(SettingsFieldGroup::new().children(fields)),
        )
    }

    /// `BackupModelsSettings`: the enabled switch, and when it is on the picker and the cards.
    fn editor_fields(
        &mut self,
        slice: &Slice,
        models: &[RegisteredModel],
        saving: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let words = super::copy::get(cx);
        let lang = Ds::get(cx).lang();
        let fallback = &slice.model_fallback;
        let (ctx, kept) = (self.ctx.clone(), fallback.clone());
        let switch = SettingsSwitch::new("model-fallback-enabled", words.backup_enabled)
            .description(words.backup_enabled_description)
            .checked(fallback.enabled)
            .disabled(saving)
            .on_change(move |enabled, _, cx| {
                ctx.save(fallback_patch(enabled, &kept.models), Save::default(), cx);
            });
        let mut fields = vec![switch.into_any_element()];
        if fallback.enabled {
            let picker = self.picker(slice, models, saving, window, cx);
            let control = Stack::new()
                .gap(Space::Sm)
                .cross(Cross::Start)
                .child(picker)
                .child(
                    StackItem::new()
                        .align_self(AlignSelf::Stretch)
                        .child(cards(&self.ctx, fallback, models, saving, lang, words)),
                );
            fields.push(
                SettingsField::new(words.backup_title)
                    .description(words.backup_description)
                    .control_width(ControlWidth::Full)
                    .control(control)
                    .into_any_element(),
            );
        }
        fields
    }

    /// `BackupModelPicker`: the Add button and its searchable popover.
    fn picker(
        &mut self,
        slice: &Slice,
        models: &[RegisteredModel],
        saving: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let words = super::copy::get(cx);
        let lang = Ds::get(cx).lang();
        let fallback = &slice.model_fallback;
        let candidates = selectable(models, &slice.model, &fallback.models);
        let this = cx.entity();
        let reset = this.clone();
        let popover =
            Popover::new("backup-model-picker", window, cx).on_open_change(move |open, _, cx| {
                if !open {
                    reset.update(cx, |page, cx| {
                        page.backup.search = SharedString::default();
                        cx.notify();
                    });
                }
            });
        let full = fallback.models.len() >= MAX_BACKUP_MODELS;
        let add_icon = icon(Icon::Plus, IconSize::Md, Ds::get(cx));
        let trigger = popover.trigger(|toggle| {
            let button = Button::new("settings-backup-model-add")
                .size(Size::Sm)
                .variant(Variant::Outline)
                .icon_start(add_icon)
                .text(words.backup_add)
                .on_click(toggle.on_click());
            let button = if saving || full {
                button.disabled()
            } else {
                button
            };
            button.into_any_element()
        });
        let empty = if full {
            words.backup_limit_reached
        } else {
            words.backup_no_candidates
        };
        let body = self.picker_body(&candidates, fallback, &popover, empty, lang, cx);
        let content = popover.content(
            PopoverContent::new()
                .align(Align::End)
                .side_offset(8.)
                .menu_size(MenuSize::Fit)
                .child(body),
            window,
            cx,
        );
        gpui::div().child(trigger).child(content).into_any_element()
    }

    /// The popover's search, provider chips and one group per provider.
    fn picker_body(
        &self,
        candidates: &[&RegisteredModel],
        fallback: &Fallback,
        popover: &Popover,
        empty: &'static str,
        lang: Lang,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let words = super::copy::get(cx);
        let mut providers: Vec<(&str, &str)> = Vec::new();
        for model in candidates {
            if !providers.iter().any(|(id, _)| *id == model.provider_id) {
                providers.push((model.provider_id.as_str(), model.provider_label.as_str()));
            }
        }
        let query = self.backup.search.trim().to_lowercase();
        let groups = providers
            .iter()
            .map(|(id, label)| {
                let items = candidates
                    .iter()
                    .filter(|model| {
                        self.backup.provider == "all" || *self.backup.provider == *model.provider_id
                    })
                    .filter(|model| model.provider_id == *id)
                    .filter(|model| {
                        query.is_empty()
                            || [
                                model.name(),
                                model.model_id.as_str(),
                                model.provider_label.as_str(),
                            ]
                            .iter()
                            .any(|value| value.to_lowercase().contains(&query))
                    })
                    .map(|model| self.item(model, fallback, popover, lang))
                    .collect();
                Group::new(id.to_string(), label.to_string(), items)
            })
            .collect();
        let chip = |id: SharedString, label: SharedString| {
            let (this, chosen) = (cx.entity(), id.clone());
            Filter::new(id, label, move |window, cx| {
                this.update(cx, |page, cx| {
                    page.backup.provider = chosen.clone();
                    cx.notify();
                });
                window.refresh();
            })
        };
        let mut filters = vec![chip("all".into(), words.backup_all_providers.into())];
        filters.extend(
            providers
                .iter()
                .map(|(id, label)| chip(id.to_string().into(), label.to_string().into())),
        );
        let this = cx.entity();
        FilteredSelectPopover::new(
            "backup-model-options",
            words.backup_add_title,
            words.backup_search,
            empty,
        )
        .search(self.backup.search.clone(), move |search, window, cx| {
            this.update(cx, |page, cx| {
                page.backup.search = search.to_owned().into();
                cx.notify();
            });
            window.refresh();
        })
        .filters(filters, self.backup.provider.clone())
        .groups(groups)
        .into_any_element()
    }

    /// One candidate row: choosing it appends it to the backup models and closes the popover.
    fn item(
        &self,
        model: &RegisteredModel,
        fallback: &Fallback,
        popover: &Popover,
        lang: Lang,
    ) -> Item {
        let (ctx, fallback, popover) = (self.ctx.clone(), fallback.clone(), popover.clone());
        let model_ref = model.model_ref.clone();
        let description = format!(
            "{} · {}",
            model.provider_label,
            token_window_label(model.context_window_tokens, composer_copy(lang))
        );
        let mark = provider_mark(&model.provider_id, model.platform.as_deref(), false);
        Item::new(model.model_ref.clone(), model.name().to_owned())
            .description(description)
            .icon(mark)
            .on_select(move |window, cx| {
                let Some(next) = add_backup(&fallback, &model_ref) else {
                    return;
                };
                ctx.save(
                    fallback_patch(next.enabled, &next.models),
                    Save::default(),
                    cx,
                );
                popover.set_open(false, window, cx);
            })
    }
}
