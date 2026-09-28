//! The stored new-chat briefing as the reader sees it: a lenient view of
//! the file and the checks that make it the requested briefing.

use serde::{Deserialize, Serialize};

use crate::lenient::{self, Arg, Obj};

/// The schema every stored briefing names.
pub(super) const NEW_CHAT_BRIEFING_SCHEMA: &str = "butler.cognition.new-chat-briefing.v1";

/// Which new-chat briefing a reader asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BriefingScope {
    /// The general briefing (`general.json`).
    General,
    /// A project's briefing (`projects/<id>.json`).
    Project,
}

impl BriefingScope {
    /// The stored scope text.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::General => "general",
            Self::Project => "project",
        }
    }
}

/// A stored new-chat briefing (`butler.cognition.new-chat-briefing.v1`)
/// that passed the reader's checks.
#[derive(Clone, Debug, PartialEq)]
pub struct NewChatBriefing {
    /// General or project.
    pub scope: BriefingScope,
    /// The project a project briefing is for.
    pub project_id: Option<String>,
    /// The project's display name when the briefing was written.
    pub project_name: Option<String>,
    /// The briefing language.
    pub locale: String,
    /// The time-of-day label the model wrote.
    pub moment: Option<String>,
    /// The headline (never empty).
    pub title: String,
    /// The sub-headline.
    pub description: String,
    /// Greetings per time of day (general briefings only).
    pub title_variants: Option<BriefingTitleVariants>,
    /// At least four suggested conversation starters; an item that is not
    /// an object reads with every field absent.
    pub suggestions: Vec<BriefingSuggestion>,
    /// Where the briefing came from.
    pub source: BriefingSource,
}

/// A general briefing's greeting for each time of day (none empty).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BriefingTitleVariants {
    /// Morning greeting.
    pub morning: String,
    /// Afternoon greeting.
    pub afternoon: String,
    /// Evening greeting.
    pub evening: String,
    /// Night greeting.
    pub night: String,
}

impl BriefingTitleVariants {
    /// The greeting for a `morning`/`afternoon`/`evening`/`night` bucket.
    pub fn for_bucket(&self, bucket: &str) -> Option<&str> {
        match bucket {
            "morning" => Some(&self.morning),
            "afternoon" => Some(&self.afternoon),
            "evening" => Some(&self.evening),
            "night" => Some(&self.night),
            _ => None,
        }
    }
}

/// One suggested conversation starter; a field of another type reads as
/// absent.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct BriefingSuggestion {
    /// Stable id.
    #[serde(default, deserialize_with = "lenient::option")]
    pub id: Option<String>,
    /// Card title.
    #[serde(default, deserialize_with = "lenient::option")]
    pub title: Option<String>,
    /// Card description.
    #[serde(default, deserialize_with = "lenient::option")]
    pub description: Option<String>,
    /// The message the card sends.
    #[serde(default, deserialize_with = "lenient::option")]
    pub text: Option<String>,
}

/// Where a stored briefing came from; a field of another type reads as
/// absent.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct BriefingSource {
    /// The consolidation run that wrote it.
    #[serde(default, deserialize_with = "lenient::option")]
    pub consolidation_run_id: Option<String>,
    /// When it was written.
    #[serde(default, deserialize_with = "lenient::option")]
    pub generated_at: Option<String>,
    /// Whether the persona shaped it.
    #[serde(default, deserialize_with = "lenient::option")]
    pub persona_applied: Option<bool>,
    /// The profile projection it used, when any.
    #[serde(default, deserialize_with = "lenient::option")]
    pub profile_projection_id: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    raw_text_included: Option<bool>,
}

/// A stored briefing file as read, before the checks.
#[derive(Deserialize)]
pub(super) struct StoredBriefing {
    #[serde(default, deserialize_with = "lenient::option")]
    schema: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    scope: Option<BriefingScope>,
    #[serde(default, deserialize_with = "lenient::option")]
    project_id: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    project_name: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    locale: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    moment: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    title: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    description: Option<String>,
    #[serde(default)]
    title_variants: Arg<Obj<StoredTitleVariants>>,
    #[serde(default, deserialize_with = "lenient::items")]
    suggestions: Option<Vec<Option<BriefingSuggestion>>>,
    #[serde(default, deserialize_with = "lenient::option")]
    source: Option<Obj<BriefingSource>>,
    #[serde(default, deserialize_with = "lenient::option")]
    raw_text_included: Option<bool>,
}

/// Stored greetings; each must be a non-empty string.
#[derive(Deserialize)]
struct StoredTitleVariants {
    #[serde(default, deserialize_with = "lenient::option")]
    morning: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    afternoon: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    evening: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    night: Option<String>,
}

impl StoredTitleVariants {
    fn checked(self) -> Option<BriefingTitleVariants> {
        let text = |value: Option<String>| value.filter(|text| !text.is_empty());
        Some(BriefingTitleVariants {
            morning: text(self.morning)?,
            afternoon: text(self.afternoon)?,
            evening: text(self.evening)?,
            night: text(self.night)?,
        })
    }
}

impl StoredBriefing {
    /// The briefing when it is the requested one: the schema, scope, locale
    /// and project match, the title is not empty, raw text is marked absent,
    /// at least four suggestions are listed, and greetings, when present,
    /// are all non-empty.
    pub(super) fn checked(
        self,
        scope: BriefingScope,
        project_id: Option<&str>,
        locale: &str,
    ) -> Option<NewChatBriefing> {
        let source = self.source.map(|Obj(source)| source).unwrap_or_default();
        if self.schema.as_deref() != Some(NEW_CHAT_BRIEFING_SCHEMA)
            || self.scope != Some(scope)
            || self.locale.as_deref() != Some(locale)
            || (scope == BriefingScope::Project
                && self.project_id.as_deref() != Some(project_id.unwrap_or_default()))
            || source.raw_text_included != Some(false)
            || self.raw_text_included != Some(false)
        {
            return None;
        }
        let suggestions = self.suggestions.filter(|items| items.len() >= 4)?;
        let title_variants = match self.title_variants {
            Arg::Missing => None,
            Arg::Valid(Obj(variants)) => Some(variants.checked()?),
            Arg::Null | Arg::Invalid(_) => return None,
        };
        Some(NewChatBriefing {
            scope,
            project_id: self.project_id,
            project_name: self.project_name,
            locale: self.locale?,
            moment: self.moment,
            title: self.title.filter(|title| !title.is_empty())?,
            description: self.description?,
            title_variants,
            suggestions: suggestions
                .into_iter()
                .map(Option::unwrap_or_default)
                .collect(),
            source,
        })
    }
}
