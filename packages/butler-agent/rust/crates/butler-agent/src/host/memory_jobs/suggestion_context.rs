//! One context per nightly run for Butler's suggestions: what the user did lately and what already exists.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use butler_platform::sqlite;
use chrono::{DateTime, Duration, Utc};
use rusqlite::{OpenFlags, OptionalExtension};
use serde_json::{Value, json};

use butler_gateway::gateway::{AppSuggestionChat, read_suggestion_context};
use butler_ledger::project_ledger::ProjectLedger;
use butler_memory::cognition::{
    BriefingScope, CognitionPathEnvironment, PatternRepository, active_memory_descriptor_exists,
    resolve_active_generation,
};
use butler_memory::profile::{ProfileService, ProfilingMode};

const SUMMARY_CHARS: usize = 800;

pub(in crate::host) struct SuggestionContextBuilder {
    data_root: PathBuf,
    app_database_path: PathBuf,
    paths: CognitionPathEnvironment,
    ledger: ProjectLedger,
    patterns: PatternRepository,
    profile: Arc<ProfileService>,
    built: tokio::sync::Mutex<Option<(String, Arc<Value>)>>,
}

impl SuggestionContextBuilder {
    pub(in crate::host) fn new(
        data_root: PathBuf,
        paths: CognitionPathEnvironment,
        ledger: ProjectLedger,
        patterns: PatternRepository,
        profile: Arc<ProfileService>,
    ) -> Self {
        let app_database_path =
            crate::host::service::configuration::AppServiceConfiguration::capture(&data_root)
                .db_path;
        Self {
            data_root,
            app_database_path,
            paths,
            ledger,
            patterns,
            profile,
            built: tokio::sync::Mutex::new(None),
        }
    }

    pub(in crate::host) fn patterns(&self) -> PatternRepository {
        self.patterns.clone()
    }

    pub(in crate::host) async fn context(
        &self,
        run_id: &str,
        locale: &str,
        now: DateTime<Utc>,
    ) -> std::io::Result<Arc<Value>> {
        let mut built = self.built.lock().await;
        if let Some((id, value)) = built.as_ref()
            && id == run_id
        {
            return Ok(value.clone());
        }
        let value = Arc::new(self.build(locale, now).await?);
        *built = Some((run_id.to_owned(), value.clone()));
        Ok(value)
    }

    async fn build(&self, locale: &str, now: DateTime<Utc>) -> std::io::Result<Value> {
        let since = (now - Duration::days(30)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let learning = !matches!(
            self.profile
                .read_profiling_consent()
                .await
                .map_err(std::io::Error::other)?
                .mode,
            ProfilingMode::Off
        );
        let data = self.data_root.clone();
        let paths = self.paths.clone();
        let app_path = self.app_database_path.clone();
        let local_since = since.clone();
        let locale = locale.to_owned();
        let mut local = tokio::task::spawn_blocking(move || {
            read_local(&data, &paths, &app_path, &local_since, learning, &locale)
        })
        .await
        .map_err(std::io::Error::other)??;
        let work = super::briefing::project_signals(self.app_database_path.clone(), &self.ledger, self.paths.cognition_root(&self.data_root).join("consolidation")).await.map_err(std::io::Error::other)?
            .into_iter().map(|p| json!({"project":p.display_name,"open":p.open_work_titles,"completed":p.completed_work_titles})).collect::<Vec<_>>();
        let earlier = self
            .patterns
            .offered_since(now - Duration::days(60))
            .await
            .map_err(std::io::Error::other)?;
        local["since"] = since[..10].into();
        local["work"] = work.into();
        local["earlier_suggestions"] = earlier.into();
        Ok(local)
    }
}

fn read_local(
    data: &Path,
    paths: &CognitionPathEnvironment,
    app: &Path,
    since: &str,
    learning: bool,
    locale: &str,
) -> std::io::Result<Value> {
    let app_context =
        read_suggestion_context(app, since, learning).map_err(std::io::Error::other)?;
    let summaries = if learning {
        summaries(data, paths, &app_context.chats, since)?
    } else {
        HashMap::new()
    };
    let instructions = butler_memory::cognition::list_remembered_rules(
        &butler_memory::cognition::explicit_memory_rules_root(&paths.memory_root(data)),
        None,
    )
    .map_err(std::io::Error::other)?
    .into_iter()
    .map(|rule| rule.text)
    .collect::<Vec<_>>();
    let earlier_cards = butler_memory::cognition::read_new_chat_briefing(
        data,
        None,
        BriefingScope::General,
        None,
        locale,
    )
    .map(|briefing| {
        briefing
            .suggestions
            .into_iter()
            .map(|card| json!({"title":card.title,"description":card.description}))
            .collect::<Vec<_>>()
    })
    .unwrap_or_default();
    Ok(
        json!({"conversations":app_context.chats.iter().map(|c| conversation(c, summaries.get(&c.runtime_session_id))).collect::<Vec<_>>(),
        "schedules":app_context.schedules,"drawer":{"groups":app_context.drawer_groups,"items":app_context.drawer_items},
        "instructions":instructions,"earlier_cards":earlier_cards}),
    )
}

fn summaries(
    data: &Path,
    paths: &CognitionPathEnvironment,
    chats: &[AppSuggestionChat],
    since: &str,
) -> std::io::Result<HashMap<String, String>> {
    let store_path = butler_turn::conversation::conversation_store_path(data);
    if chats.is_empty()
        || !store_path.exists()
        || !active_memory_descriptor_exists(data, paths).map_err(std::io::Error::other)?
    {
        return Ok(HashMap::new());
    }
    let store = sqlite::open_with_flags(store_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(std::io::Error::other)?;
    let mut owners = HashMap::new();
    for chat in chats {
        let session: Option<String> = store.query_row("SELECT conversation_session_id FROM conversation_bindings WHERE external_session_id=?1", [&chat.runtime_session_id], |row| row.get(0)).optional().map_err(std::io::Error::other)?;
        if let Some(session) = session {
            owners.insert(session, chat.runtime_session_id.clone());
        }
    }
    let generation = resolve_active_generation(data, paths).map_err(std::io::Error::other)?;
    let graph = sqlite::open_with_flags(&generation.graph_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(std::io::Error::other)?;
    let mut statement = graph.prepare("SELECT conversation_session_id,summary FROM memory_chunks WHERE status='active' AND summary<>'' AND conversation_session_id IS NOT NULL AND COALESCE(conversation_end,updated_at)>=?1 ORDER BY COALESCE(conversation_end,updated_at) DESC").map_err(std::io::Error::other)?;
    let rows = statement
        .query_map([since], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(std::io::Error::other)?;
    let mut summaries: HashMap<String, (usize, Vec<String>)> = HashMap::new();
    for row in rows {
        let (session, summary) = row.map_err(std::io::Error::other)?;
        if let Some(owner) = owners.get(&session) {
            let (used, parts) = summaries.entry(owner.clone()).or_default();
            if *used < SUMMARY_CHARS {
                let part: String = summary.chars().take(SUMMARY_CHARS - *used).collect();
                *used += part.chars().count();
                parts.push(part);
            }
        }
    }
    Ok(summaries
        .into_iter()
        .map(|(id, (_, mut parts))| {
            parts.reverse();
            (id, parts.join("\n"))
        })
        .collect())
}

fn conversation(chat: &AppSuggestionChat, summary: Option<&String>) -> Value {
    let mut value = json!({"id":chat.id,"title":chat.title,"project":chat.project,"last_active":chat.last_active});
    if let Some(summary) = summary {
        value["summary"] = summary.clone().into();
    } else {
        value["first_request"] = json!(chat.first_request);
        value["last_reply"] = json!(chat.last_reply);
    }
    value
}
