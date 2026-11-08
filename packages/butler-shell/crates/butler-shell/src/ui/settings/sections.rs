//! The settings pages: `settingsSectionIds.ts` (order; logs only in developer mode, after usage),
//! `settingsSections.tsx` (icons and the three groups), `settingsSearch.ts` (label, description
//! and alias matching), `normalizeSettingsSectionId` (app/utils.ts) and `SettingsDetailContent`
//! (one page per section).
mod about;
mod appearance;
mod archives;
mod browser;
mod general;
mod hooks;
mod logs;
mod mcp;
mod memory;
mod models;
mod personalization;
mod security;
mod server;
mod skills;
mod system;
mod updates;
mod usage;

use butler_ds::ui::context::Lang;
use gpui::{AnyView, App, Window};

use super::SectionCtx;
use crate::ui::Icon;
use crate::ui::i18n::settings::{Localized, SETTINGS_SECTIONS, memory_assigned, words};

/// `SettingsSectionId`, in the order of `SETTINGS_SECTIONS`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum SectionId {
    General,
    Appearance,
    Personalization,
    Memory,
    Models,
    Updates,
    Usage,
    Logs,
    Browser,
    Security,
    System,
    Archives,
    About,
    Mcp,
    Hooks,
    Skills,
    Server,
}

/// `BASE_SETTINGS_SECTION_IDS` (settingsSectionIds.ts:4): logs is not in it.
const BASE: [SectionId; 16] = [
    SectionId::General,
    SectionId::Appearance,
    SectionId::Personalization,
    SectionId::Memory,
    SectionId::Models,
    SectionId::Updates,
    SectionId::Usage,
    SectionId::Browser,
    SectionId::Security,
    SectionId::System,
    SectionId::Archives,
    SectionId::About,
    SectionId::Mcp,
    SectionId::Hooks,
    SectionId::Skills,
    SectionId::Server,
];

/// `visibleSettingsSectionIds`: developer mode inserts logs after usage.
pub(crate) fn visible(developer: bool) -> Vec<SectionId> {
    let mut ids = BASE.to_vec();
    if developer {
        let at = ids
            .iter()
            .position(|id| *id == SectionId::Usage)
            .map_or(ids.len(), |index| index + 1);
        ids.insert(at, SectionId::Logs);
    }
    ids
}

impl SectionId {
    /// "general", "appearance", ...: the palette routes and the page keys.
    pub(crate) fn id(self) -> &'static str {
        SETTINGS_SECTIONS[self as usize].id
    }

    pub(crate) fn copy(self, lang: Lang) -> &'static Localized {
        SETTINGS_SECTIONS[self as usize].of(lang)
    }

    /// settingsSections.tsx:31-48
    pub(crate) fn icon(self) -> Icon {
        match self {
            Self::General => Icon::SlidersHorizontal,
            Self::Appearance => Icon::Palette,
            Self::Personalization => Icon::UserRound,
            Self::Memory => Icon::Notebook,
            Self::Models => Icon::AiChip,
            Self::Updates => Icon::RefreshCcw,
            Self::Usage => Icon::Database,
            Self::Logs | Self::Hooks => Icon::Terminal,
            Self::Browser => Icon::Globe2,
            Self::Security => Icon::Lock,
            Self::System => Icon::Activity,
            Self::Archives => Icon::Archive,
            Self::About => Icon::BookOpenText,
            Self::Mcp => Icon::McpServer,
            Self::Skills => Icon::MagicWand,
            Self::Server => Icon::Server,
        }
    }

    /// `settingsSearchAliases`: the page's aliases without the labels another page took over,
    /// plus the labels it took over.
    fn aliases(self, lang: Lang) -> Vec<&'static str> {
        let assigned = memory_assigned(lang);
        let owner = self == Self::Memory;
        let mut aliases: Vec<&'static str> = self
            .copy(lang)
            .aliases
            .iter()
            .copied()
            .filter(|alias| owner || !assigned.iter().any(|label| same(label, alias)))
            .collect();
        if owner {
            aliases.extend(assigned.iter().copied());
        }
        aliases
    }
}

/// `SETTINGS_SECTION_GROUPS` (settingsSections.tsx:77-106).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Group {
    Preferences,
    AppAndSystem,
    Advanced,
}

impl Group {
    /// The group's key (`SettingsSectionGroupId`).
    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::Preferences => "general",
            Self::AppAndSystem => "app-and-system",
            Self::Advanced => "advanced",
        }
    }

    pub(crate) fn label(self, lang: Lang) -> &'static str {
        let copy = words(lang);
        match self {
            Self::Preferences => copy.group_preferences,
            Self::AppAndSystem => copy.group_app_and_system,
            Self::Advanced => copy.group_advanced,
        }
    }
}

pub(crate) const GROUPS: [(Group, &[SectionId]); 3] = [
    (
        Group::Preferences,
        &[
            SectionId::General,
            SectionId::Appearance,
            SectionId::Personalization,
            SectionId::Memory,
            SectionId::Models,
        ],
    ),
    (
        Group::AppAndSystem,
        &[
            SectionId::Updates,
            SectionId::Usage,
            SectionId::Logs,
            SectionId::Browser,
            SectionId::Security,
            SectionId::System,
            SectionId::Archives,
            SectionId::About,
        ],
    ),
    // Agent-level settings most people never need; always the last group.
    (
        Group::Advanced,
        &[
            SectionId::Mcp,
            SectionId::Hooks,
            SectionId::Skills,
            SectionId::Server,
        ],
    ),
];

/// `normalizeSettingsSearchValue`
fn normalized(value: &str) -> String {
    value.trim().to_lowercase()
}

fn same(a: &str, b: &str) -> bool {
    normalized(a) == normalized(b)
}

/// `matchesSettingsSection`: the label, description or an alias contains the query.
pub(crate) fn matches(id: SectionId, query: &str, lang: Lang) -> bool {
    let query = normalized(query);
    let copy = id.copy(lang);
    [copy.label, copy.description]
        .into_iter()
        .chain(id.aliases(lang))
        .any(|value| normalized(value).contains(&query))
}

/// `createSettingsSectionGroups` filtered by `filterSettingsSectionGroups`: a group whose label
/// matches keeps all its pages; otherwise only the matching pages; empty groups drop.
pub(crate) fn groups(developer: bool, query: &str, lang: Lang) -> Vec<(Group, Vec<SectionId>)> {
    let shown = visible(developer);
    let query = normalized(query);
    GROUPS
        .iter()
        .map(|(group, ids)| {
            let ids = ids.iter().copied().filter(|id| shown.contains(id));
            let whole = query.is_empty() || normalized(group.label(lang)).contains(&query);
            let ids: Vec<SectionId> = if whole {
                ids.collect()
            } else {
                ids.filter(|id| matches(*id, &query, lang)).collect()
            };
            (*group, ids)
        })
        .filter(|(_, ids)| !ids.is_empty())
        .collect()
}

/// `normalizeSettingsSectionId`, in its order: exact names, then substrings.
const RULES: [(&[&str], &[&str], SectionId); 19] = [
    (&["memory"], &[], SectionId::Memory),
    (&["updates"], &[], SectionId::Updates),
    (
        &[],
        &["default-permission", "access-mode", "기본 권한"],
        SectionId::General,
    ),
    (
        &[],
        &[
            "browser",
            "브라우저",
            "sign-in",
            "signin",
            "signins",
            "로그인",
            "browser-import",
        ],
        SectionId::Browser,
    ),
    (
        &[],
        &["security", "보안", "개인정보", "진단", "권한", "access"],
        SectionId::Security,
    ),
    (
        &["logs"],
        &["developer-log", "log", "로그"],
        SectionId::Logs,
    ),
    (&[], &["appearance"], SectionId::Appearance),
    (&[], &["server", "bridge"], SectionId::Server),
    (&["hooks", "훅"], &[], SectionId::Hooks),
    (&[], &["mcp"], SectionId::Mcp),
    (&[], &["skill"], SectionId::Skills),
    // Backup, cleanup and worker models live on the Models page.
    (
        &[],
        &["helper", "worker", "backup", "fallback"],
        SectionId::Models,
    ),
    (&[], &["usage", "metrics", "사용량"], SectionId::Usage),
    (&[], &["model"], SectionId::Models),
    (&[], &["about", "info", "정보"], SectionId::About),
    (&[], &["persona", "personal"], SectionId::Personalization),
    (&[], &["archive"], SectionId::Archives),
    (
        &[],
        &["system", "event", "scheduler", "consolidation"],
        SectionId::System,
    ),
    (&[], &["privacy", "data", "diagnostic"], SectionId::Security),
];

/// `normalizeSettingsSectionId`: any route or legacy page name to a page; general otherwise.
pub(crate) fn normalize(value: &str) -> SectionId {
    let section = value.to_lowercase();
    RULES
        .iter()
        .find(|(exact, contains, _)| {
            exact.contains(&section.as_str()) || contains.iter().any(|part| section.contains(*part))
        })
        .map_or(SectionId::General, |(_, _, id)| *id)
}

/// `SettingsDetailContent`: the page of a section.
pub(crate) fn page(id: SectionId, ctx: SectionCtx, window: &mut Window, cx: &mut App) -> AnyView {
    match id {
        SectionId::General => general::page(ctx, window, cx),
        SectionId::Appearance => appearance::page(ctx, window, cx),
        SectionId::Personalization => personalization::page(ctx, window, cx),
        SectionId::Memory => memory::page(ctx, window, cx),
        SectionId::Models => models::page(ctx, window, cx),
        SectionId::Updates => updates::page(ctx, window, cx),
        SectionId::Usage => usage::page(ctx, window, cx),
        SectionId::Logs => logs::page(ctx, window, cx),
        SectionId::Browser => browser::page(ctx, window, cx),
        SectionId::Security => security::page(ctx, window, cx),
        SectionId::System => system::page(ctx, window, cx),
        SectionId::Archives => archives::page(ctx, window, cx),
        SectionId::About => about::page(ctx, window, cx),
        SectionId::Mcp => mcp::page(ctx, window, cx),
        SectionId::Hooks => hooks::page(ctx, window, cx),
        SectionId::Skills => skills::page(ctx, window, cx),
        SectionId::Server => server::page(ctx, window, cx),
    }
}
