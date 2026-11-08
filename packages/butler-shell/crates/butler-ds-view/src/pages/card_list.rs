//! CardList.showcase.tsx: the capped skills list, MCP servers with actions, the empty list and
//! the settings flush variant (rows without their own cards, divided by hairlines).
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::card_list::{CardList, CardListItem};
use butler_ds::ui::blocks::settings_section::{SettingsPage, SettingsSection, SettingsSectionKind};
use butler_ds::ui::button::{Button, Size, Variant, container};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::switch::Switch;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::{Story, sub};
use crate::copy::Lang;

struct Copy {
    skills: &'static str,
    servers: &'static str,
    add: &'static str,
    no_skills: &'static str,
    no_mcp: &'static str,
    probe: &'static str,
    enable: &'static str,
    disable: &'static str,
    enabled: &'static str,
    disabled: &'static str,
    /// Name, description, source, invocable.
    skill_rows: [(&'static str, &'static str, &'static str, bool); 4],
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            skills: "Project skills",
            servers: "Servers",
            add: "Add server",
            no_skills: "No skills yet.",
            no_mcp: "No MCP servers yet.",
            probe: "Test",
            enable: "Turn on",
            disable: "Turn off",
            enabled: "On",
            disabled: "Off",
            skill_rows: [
                (
                    "project-ledger",
                    "Inspect, query, render, and validate project records.",
                    "core",
                    true,
                ),
                (
                    "browser",
                    "Open and inspect local web targets.",
                    "user",
                    false,
                ),
                (
                    "butler-ship-feature",
                    "Run Butler work through spec, task, review, and validation.",
                    "core",
                    true,
                ),
                (
                    "butler-design-system",
                    "Assemble UI only from the Butler design system.",
                    "project",
                    true,
                ),
            ],
        },
        Copy {
            skills: "프로젝트 스킬",
            servers: "서버",
            add: "서버 추가",
            no_skills: "아직 스킬이 없습니다.",
            no_mcp: "아직 MCP 서버가 없습니다.",
            probe: "테스트",
            enable: "켜기",
            disable: "끄기",
            enabled: "켜짐",
            disabled: "꺼짐",
            skill_rows: [
                (
                    "project-ledger",
                    "프로젝트 기록을 살펴보고 조회하고 검증합니다.",
                    "core",
                    true,
                ),
                ("browser", "로컬 웹 대상을 열어 살펴봅니다.", "user", false),
                (
                    "butler-ship-feature",
                    "명세, 작업, 검토, 검증 순서로 작업을 진행합니다.",
                    "core",
                    true,
                ),
                (
                    "butler-design-system",
                    "버틀러 디자인 시스템으로만 UI를 조립합니다.",
                    "project",
                    true,
                ),
            ],
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Skills (max 3 rows)",
            render: skills,
        },
        Story {
            name: "MCP servers with actions",
            render: servers,
        },
        Story {
            name: "Empty",
            render: empty,
        },
        Story {
            name: "In a settings section (flush rows)",
            render: flush,
        },
    ]
}

/// SkillGroup: capped rows; the list scrolls past `max_visible_rows`.
fn skills(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    let rows = c
        .skill_rows
        .iter()
        .map(|&(name, description, source, invocable)| {
            let glyph = if invocable {
                Icon::Sparkles
            } else {
                Icon::FileText
            };
            CardListItem::new(name, name)
                .description(description)
                .icon(icon(glyph, IconSize::Md, ds))
                .meta(source)
        });
    CardList::new("cl-skills")
        .title(c.skills)
        .max_visible_rows(3)
        .empty(Typo::caption(c.no_skills))
        .children(rows)
        .into_any_element()
}

fn probe_actions(id: &'static str, c: &Copy, toggle: &'static str) -> AnyElement {
    container(Size::Xs)
        .child(
            Button::new(sub(id, "probe"))
                .size(Size::Xs)
                .variant(Variant::Outline)
                .text(c.probe),
        )
        .child(
            Button::new(sub(id, "toggle"))
                .size(Size::Xs)
                .variant(Variant::Borderless)
                .text(toggle),
        )
        .into_any_element()
}

/// McpServerRow: the toggle state as meta and compact actions.
fn servers(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    CardList::new("cl-servers")
        .child(
            CardListItem::new("cl-github", "GitHub")
                .description("stdio · npx @modelcontextprotocol/server-github")
                .meta(c.enabled)
                .selected(true)
                .actions(probe_actions("cl-github-actions", &c, c.disable)),
        )
        .child(
            CardListItem::new("cl-linear", "Linear")
                .description("http · https://mcp.linear.app/sse")
                .meta(c.disabled)
                .actions(probe_actions("cl-linear-actions", &c, c.enable)),
        )
        .into_any_element()
}

fn empty(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    CardList::new("cl-empty")
        .empty(Typo::caption(copy(lang).no_mcp).tone(Tone::Secondary))
        .into_any_element()
}

fn switch_actions(id: &'static str, on: bool, c: &Copy) -> AnyElement {
    container(Size::Xs)
        .child(
            Button::new(sub(id, "probe"))
                .size(Size::Xs)
                .variant(Variant::Outline)
                .text(c.probe),
        )
        .child(Switch::new(sub(id, "switch")).default_checked(on))
        .into_any_element()
}

/// Inside a section card the rows drop their own card and share hairlines.
fn flush(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let add = Button::new("cl-add")
        .size(Size::Sm)
        .variant(Variant::Outline)
        .icon_start(icon(Icon::Plus, IconSize::Md, Ds::get(cx)))
        .text(c.add);
    let list = CardList::new("cl-flush")
        .flush()
        .child(
            CardListItem::new("cl-flush-github", "GitHub")
                .description("stdio · npx @modelcontextprotocol/server-github")
                .meta(c.enabled)
                .actions(switch_actions("cl-flush-github-actions", true, &c)),
        )
        .child(
            CardListItem::new("cl-flush-linear", "Linear")
                .description("http · https://mcp.linear.app/sse")
                .meta(c.disabled)
                .actions(switch_actions("cl-flush-linear-actions", false, &c)),
        );
    SettingsPage::new()
        .section(
            SettingsSection::new("cardlist-servers", SettingsSectionKind::List, c.servers)
                .actions(add)
                .child(list),
        )
        .into_any_element()
}
