//! `ComposerMentionMenu`, `mentionCandidates.ts`, `mentionToken.ts`.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::suggestion_list::{SuggestionItemRow, SuggestionList};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use gpui::{App, ParentElement as _, SharedString, Window};

use super::atoms::session_display_title;
use super::{Atom, ComposerPart};
use crate::ui::i18n::Locale;
use crate::ui::source::wire::{NavigationView, SessionSummary};

/// The `@` word the caret is in: `@` at the start of the text or after whitespace, then
/// non-space text (`MentionToken`). Offsets are byte offsets in the text run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MentionToken {
    /// Offset of the `@`.
    pub(crate) start: usize,
    /// The caret offset; the query is the text between.
    pub(crate) end: usize,
    pub(crate) query: String,
}

/// `$mentionToken`: the token ending at `caret` in `text` (`/(?:^|\s)@([^\s@]*)$/u`).
pub(crate) fn mention_token(text: &str, caret: usize) -> Option<MentionToken> {
    let head = text.get(..caret)?;
    let query_start = head
        .char_indices()
        .rev()
        .take_while(|(_, c)| !c.is_whitespace() && *c != '@')
        .last()
        .map_or(head.len(), |(at, _)| at);
    let at = query_start.checked_sub(1)?;
    if !head[..query_start].ends_with('@') {
        return None;
    }
    if !head[..at]
        .chars()
        .next_back()
        .is_none_or(char::is_whitespace)
    {
        return None;
    }
    Some(MentionToken {
        start: at,
        end: caret,
        query: head[query_start..].to_owned(),
    })
}

/// `replaceMentionToken`: the parts that replace the `@word` under the caret in `text` with
/// `atom` and a following space (none added when whitespace follows already). The caller
/// runs it once the IME is idle and applies it as one undo step.
pub(crate) fn replace_mention_token(
    text: &str,
    caret: usize,
    atom: Atom,
) -> Option<Vec<ComposerPart>> {
    let token = mention_token(text, caret)?;
    let after = &text[token.end..];
    let spaced = after.chars().next().is_some_and(char::is_whitespace);
    let tail = if spaced {
        after.to_owned()
    } else {
        format!(" {after}")
    };
    let mut parts = Vec::new();
    if token.start > 0 {
        parts.push(ComposerPart::Text(text[..token.start].to_owned()));
    }
    parts.push(ComposerPart::Atom(atom));
    parts.push(ComposerPart::Text(tail));
    Some(parts)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MentionKind {
    Session,
    Project,
}

/// One `@` mention target: a conversation or a whole project.
#[derive(Clone, Debug)]
pub(crate) struct MentionCandidate {
    pub(crate) kind: MentionKind,
    pub(crate) id: String,
    pub(crate) title: String,
    /// The project a project conversation belongs to.
    pub(crate) project_name: Option<String>,
    pub(crate) in_project: bool,
    /// Last use or change (ISO time); newer first.
    pub(crate) recent: String,
    /// Lowercased title and project name, computed once per navigation snapshot.
    title_lower: String,
    words: Vec<String>,
    project_lower: String,
}

pub(crate) const MENTION_LIMIT: usize = 7;

fn is_word_break(c: char) -> bool {
    c.is_whitespace() || "-_/·.,:;()[]{}".contains(c)
}

fn candidate(
    kind: MentionKind,
    id: &str,
    title: String,
    recent: &str,
    project_name: Option<&str>,
) -> MentionCandidate {
    let lower = title.to_lowercase();
    MentionCandidate {
        kind,
        id: id.to_owned(),
        words: lower
            .split(is_word_break)
            .filter(|word| !word.is_empty())
            .map(str::to_owned)
            .collect(),
        title_lower: lower,
        title,
        project_name: project_name.map(str::to_owned),
        in_project: project_name.is_some(),
        recent: recent.to_owned(),
        project_lower: project_name.map(str::to_lowercase).unwrap_or_default(),
    }
}

fn session_candidate(
    session: &SessionSummary,
    general: &str,
    project_name: Option<&str>,
) -> MentionCandidate {
    let recent = if session.last_activity_at.is_empty() {
        &session.updated_at
    } else {
        &session.last_activity_at
    };
    candidate(
        MentionKind::Session,
        &session.id,
        session_display_title(&session.id, &session.title, general).to_string(),
        recent,
        project_name,
    )
}

/// Every conversation and project the client already lists, except the conversation being
/// written in.
pub(crate) fn mention_candidates(
    navigation: &NavigationView,
    current_session_id: &str,
    general: &str,
) -> Vec<MentionCandidate> {
    let mut all = Vec::new();
    for project in navigation
        .projects
        .iter()
        .filter(|project| !project.archived)
    {
        all.push(candidate(
            MentionKind::Project,
            &project.id,
            project.display_name.clone(),
            &project.last_activity_at,
            None,
        ));
        for session in project.sessions.iter().flatten().filter(|s| !s.archived) {
            all.push(session_candidate(
                session,
                general,
                Some(&project.display_name),
            ));
        }
    }
    for chat in navigation.chats.iter().filter(|chat| !chat.archived) {
        all.push(session_candidate(chat, general, None));
    }
    let mut seen = vec![current_session_id.to_owned()];
    all.retain(|item| {
        if item.kind == MentionKind::Project {
            return true;
        }
        if seen.contains(&item.id) {
            return false;
        }
        seen.push(item.id.clone());
        true
    });
    all
}

/// Lower is better: the title starts with the query, a title word does, the title contains it,
/// only the project name does.
fn match_rank(item: &MentionCandidate, query: &str) -> Option<u8> {
    if item.title_lower.starts_with(query) {
        Some(0)
    } else if item.words.iter().any(|word| word.starts_with(query)) {
        Some(1)
    } else if item.title_lower.contains(query) {
        Some(2)
    } else if item.project_lower.contains(query) {
        Some(3)
    } else {
        None
    }
}

/// A bare `@` lists the most recent items; a typed query lists matches by quality, then recency.
pub(crate) fn rank_mentions(
    candidates: &[MentionCandidate],
    raw_query: &str,
) -> Vec<MentionCandidate> {
    let query = raw_query.to_lowercase();
    if query.is_empty() {
        let mut all: Vec<_> = candidates.to_vec();
        all.sort_by(|a, b| b.recent.cmp(&a.recent));
        all.truncate(MENTION_LIMIT);
        return all;
    }
    let mut ranked: Vec<_> = candidates
        .iter()
        .filter_map(|item| match_rank(item, &query).map(|rank| (rank, item)))
        .collect();
    ranked.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| b.1.recent.cmp(&a.1.recent)));
    ranked
        .into_iter()
        .take(MENTION_LIMIT)
        .map(|(_, item)| item.clone())
        .collect()
}

impl MentionCandidate {
    /// The atom the chip inserts (`choose`).
    pub(crate) fn atom(&self) -> Atom {
        let label = SharedString::from(self.title.clone());
        match self.kind {
            MentionKind::Project => Atom::Project {
                id: self.id.clone(),
                label,
            },
            MentionKind::Session => Atom::Session {
                id: self.id.clone(),
                label,
            },
        }
    }
}

/// The menu's own state: the token under the caret, whether Escape closed it, and the
/// highlighted row.
#[derive(Default)]
pub(crate) struct MentionMenu {
    token: Option<MentionToken>,
    dismissed: bool,
    active: usize,
}

impl MentionMenu {
    pub(crate) fn token(&self) -> Option<&MentionToken> {
        self.token.as_ref()
    }

    pub(crate) fn active(&self) -> usize {
        self.active
    }

    /// The caret moved or the text changed: closing resets when the token goes, and the
    /// highlight returns to the first row when the query or its place changes.
    pub(crate) fn set_token(&mut self, token: Option<MentionToken>) {
        if token.is_none() {
            self.dismissed = false;
        }
        if token != self.token {
            self.active = 0;
        }
        self.token = token;
    }

    /// Open: a token, not dismissed, and at least one row.
    pub(crate) fn is_open(&self, rows: usize) -> bool {
        self.token.is_some() && !self.dismissed && rows > 0
    }

    pub(crate) fn dismiss(&mut self) {
        self.dismissed = true;
    }

    /// Arrow keys wrap around the `rows`.
    pub(crate) fn step(&mut self, step: isize, rows: usize) {
        if rows > 0 {
            self.active = (self.active as isize + step).rem_euclid(rows as isize) as usize;
        }
    }

    /// The row Enter or Tab chooses. A key can arrive before the menu re-renders a
    /// just-committed syllable, so the word the editor holds now (`now`) decides: the
    /// highlighted row while its query is the rendered one, else the best match for it.
    pub(crate) fn pick(
        &self,
        now: Option<&MentionToken>,
        items: &[MentionCandidate],
        candidates: &[MentionCandidate],
    ) -> Option<MentionCandidate> {
        let now = now?;
        if Some(&now.query) == self.token.as_ref().map(|token| &token.query) {
            items.get(self.active).cloned()
        } else {
            rank_mentions(candidates, &now.query).into_iter().next()
        }
    }
}

/// composer.mentionList, composer.mentionProject.
pub(crate) fn mention_list_label(locale: Locale) -> &'static str {
    match locale {
        Locale::Ko => "대화·프로젝트 참조",
        Locale::En => "Reference a chat or project",
    }
}

fn mention_project_label(locale: Locale) -> &'static str {
    match locale {
        Locale::Ko => "프로젝트",
        Locale::En => "Project",
    }
}

/// The menu's list: a conversation or project per row. The caller anchors it above the `@`
/// (`side="top"`, `align="start"`, 6px offset) in a popover and passes `choose` for a click.
pub(crate) fn mention_list(
    items: &[MentionCandidate],
    query: &str,
    active: usize,
    locale: Locale,
    choose: impl Fn(&MentionCandidate, &mut Window, &mut App) + Clone + 'static,
    cx: &App,
) -> SuggestionList {
    let ds = Ds::get(cx);
    let mut list = SuggestionList::new();
    for (index, item) in items.iter().enumerate() {
        let glyph = match (item.kind, item.in_project) {
            (MentionKind::Project, _) => Icon::Briefcase,
            (MentionKind::Session, true) => Icon::Notebook,
            (MentionKind::Session, false) => Icon::MessageSquare,
        };
        let chosen = item.clone();
        let choose = choose.clone();
        let mut row = SuggestionItemRow::new(
            SharedString::from(format!("composer-mention-list-{index}")),
            icon(glyph, IconSize::Md, ds),
            item.title.clone(),
            move |window, cx| choose(&chosen, window, cx),
        )
        .query(query.to_owned())
        .active(index == active);
        let meta = match item.kind {
            MentionKind::Project => Some(mention_project_label(locale).to_owned()),
            MentionKind::Session => item.project_name.clone(),
        };
        if let Some(meta) = meta {
            row = row.meta(meta);
        }
        if item.in_project {
            row = row.match_meta();
        }
        list = list.child(row);
    }
    list
}
