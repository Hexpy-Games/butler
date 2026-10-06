//! Public New Chat Briefing projection over Cognition artifacts and App state.

use chrono::DateTime;
use serde_json::{Value, json};

use super::AppApplication;
use crate::gateway::GatewayApplicationError;
use butler_memory::cognition::{BriefingScope, NewChatBriefing};
use butler_memory::{cognition, profile};
use butler_platform::instance::SystemTimeZone;

impl AppApplication {
    #[expect(
        clippy::match_same_arms,
        reason = "explicit arms document the known values beside the default"
    )]
    pub(super) async fn new_chat_briefing_view(
        &self,
        date: Option<String>,
        project_id: Option<String>,
    ) -> Result<Value, GatewayApplicationError> {
        let locale = self.briefing_language().await?;
        let project = if let Some(id) = project_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            Some(
                self.list_projects(false)
                    .await?
                    .projects
                    .into_iter()
                    .find(|project| project.id == id)
                    .ok_or_else(|| GatewayApplicationError::Public {
                        status: 404,
                        code: "project_not_found".into(),
                        message: "Project not found.".into(),
                        source: None,
                    })?,
            )
        } else {
            None
        };
        let data_root = self.butler_data.clone();
        let now = self.dependencies.identity_clock.now_iso();
        tokio::task::spawn_blocking(move || {
            let epoch_ms = DateTime::parse_from_rfc3339(&now)
                .map_err(GatewayApplicationError::internal_from)?
                .timestamp_millis();
            let minute = local_minute(epoch_ms)?;
            let hour = minute / 60;
            let moment = format_moment(hour, minute % 60, &locale);
            let bucket = match hour {
                0..=5 => "night",
                6..=11 => "morning",
                12..=17 => "afternoon",
                18..=21 => "evening",
                _ => "night",
            };
            let scope = if project.is_some() {
                BriefingScope::Project
            } else {
                BriefingScope::General
            };
            if project.is_none() && !profile::first_chat_onboarding_complete(&data_root, &now) {
                return Ok(fallback(
                    "onboarding",
                    &locale,
                    &now,
                    &moment,
                    None,
                    None,
                    None,
                ));
            }
            let project_id = project.as_ref().map(|project| project.id.as_str());
            if let Some(artifact) = cognition::read_new_chat_briefing(
                &data_root,
                date.as_deref(),
                scope,
                project_id,
                &locale,
            ) {
                return Ok(generated_view(&artifact, &moment, bucket));
            }
            let run_id = cognition::latest_completed_briefing_run_id(&data_root, date.as_deref());
            Ok(fallback(
                scope.as_str(),
                &locale,
                &now,
                &moment,
                project.as_ref().map(|project| project.id.as_str()),
                project
                    .as_ref()
                    .map(|project| project.display_name.as_str()),
                run_id.as_ref(),
            ))
        })
        .await
        .map_err(GatewayApplicationError::internal_from)?
    }
}

fn local_minute(epoch_ms: i64) -> Result<u16, GatewayApplicationError> {
    let rules = match std::env::var("TZ") {
        Ok(zone) if zone.is_empty() => None,
        Ok(zone) => {
            let zone = zone.strip_prefix(':').unwrap_or(&zone);
            if zone.starts_with('/') {
                Some(std::fs::read(zone).map_err(GatewayApplicationError::internal_from)?)
            } else if !zone.split('/').any(|part| matches!(part, "" | "." | "..")) {
                Some(
                    butler_platform::time_zone::zone_rules(zone)
                        .map_err(GatewayApplicationError::internal_from)?,
                )
            } else {
                return Err(GatewayApplicationError::internal());
            }
        }
        Err(_) => Some(
            match butler_platform::instance::system_time_zone()
                .map_err(GatewayApplicationError::internal_from)?
            {
                SystemTimeZone::File(path) => std::fs::read(path),
                SystemTimeZone::Named(name) => butler_platform::time_zone::zone_rules(&name),
            }
            .map_err(GatewayApplicationError::internal_from)?,
        ),
    };
    let offset = if let Some(bytes) = rules {
        let zone =
            tz::TimeZone::from_tz_data(&bytes).map_err(GatewayApplicationError::internal_from)?;
        zone.find_local_time_type(epoch_ms.div_euclid(1000))
            .map_err(GatewayApplicationError::internal_from)?
            .ut_offset()
    } else {
        0
    };
    let wall = epoch_ms + i64::from(offset) * 1000;
    // A day has 1440 minutes, so this always fits.
    Ok(u16::try_from(wall.rem_euclid(86_400_000) / 60_000).unwrap_or_default())
}

fn generated_view(artifact: &NewChatBriefing, moment: &str, bucket: &str) -> Value {
    let general = artifact.scope == BriefingScope::General;
    let variants = artifact.title_variants.as_ref();
    let title = if general {
        variants.and_then(|value| value.for_bucket(bucket))
    } else {
        None
    }
    .unwrap_or(artifact.title.as_str());
    let suggestions = artifact.suggestions.iter()
        .map(|item| json!({"id":item.id, "title":item.title, "description":item.description, "text":item.text}))
        .collect::<Vec<_>>();
    let mut source = json!({
        "scope":artifact.scope.as_str(), "content_origin":"generated",
        "consolidation_run_id":artifact.source.consolidation_run_id,
        "generated_at":artifact.source.generated_at, "locale":artifact.locale,
        "persona_applied":artifact.source.persona_applied,
        "profile_projection_applied":artifact.source.profile_projection_id.as_deref().is_some_and(|id| !id.is_empty())
    });
    if let Some(id) = artifact.project_id.as_deref() {
        source["project_id"] = id.into();
    }
    if let Some(name) = artifact.project_name.as_deref() {
        source["project_name"] = name.into();
    }
    json!({
        "moment":if general && variants.is_some() { moment } else { artifact.moment.as_deref().unwrap_or_default() },
        "title":title, "description":artifact.description, "suggestions":suggestions,
        "source":source, "raw_text_included":false
    })
}

fn format_moment(hour: u16, minute: u16, locale: &str) -> String {
    let period = if hour < 12 {
        if locale == "ko" { "오전" } else { "AM" }
    } else if locale == "ko" {
        "오후"
    } else {
        "PM"
    };
    let hour = match hour % 12 {
        0 => 12,
        value => value,
    };
    if locale == "ko" {
        format!("{period} {hour}:{minute:02}")
    } else {
        format!("{hour}:{minute:02} {period}")
    }
}

fn fallback(
    scope: &str,
    locale: &str,
    now: &str,
    moment: &str,
    project_id: Option<&str>,
    project_name: Option<&str>,
    run_id: Option<&String>,
) -> Value {
    let ko = locale == "ko";
    let project_name = project_name.map(|name| if name == "butler" { "Butler" } else { name });
    let (moment, title, description, suggestions) = match scope {
        "onboarding" if ko => ("시작하기".to_owned(), "반갑습니다. 당신을 모시게 되어 기쁩니다.".to_owned(), "AI 에이전트 집사 Butler를 선택해주셔서 감사합니다. 시작하기에 앞서 간단하게 당신에 대해 알려주세요.".to_owned(), vec![card("butler-onboarding", "Butler와 알아가기", "Butler를 사용하기에 앞서 기본적인 설정을 진행합니다.", "처음 설정을 도와주세요.")]),
        "onboarding" => ("Getting started".to_owned(), "Pleased to meet you. It will be my honor to serve.".to_owned(), "Thank you for choosing Butler, your AI agent butler. Before we begin, please tell me a little about yourself.".to_owned(), vec![card("butler-onboarding", "Get acquainted with Butler", "Set up the basics before using Butler.", "Help me set up the basics.")]),
        "project" => {
            let name = project_name.unwrap_or_default();
            if ko { ("프로젝트".into(), format!("{name}에서 이어갈 일을 살펴볼까요"), format!("{name}에서 열어볼 만한 시작점 몇 가지가 있습니다."), project_cards_ko(name)) }
            else { ("Project".into(), format!("What should we continue in {name}?"), format!("A few {name} starting points are ready."), project_cards_en(name)) }
        }
        _ if ko => (moment.to_owned(), "오늘의 일을 같이 펼쳐볼까요".into(), "짧게 열어볼 만한 시작점 몇 가지가 있습니다.".into(), general_cards_ko()),
        _ => (moment.to_owned(), "What should we open today?".into(), "A few simple starting points are ready.".into(), general_cards_en()),
    };
    let mut source = json!({"scope":scope, "content_origin":"heuristic_fallback", "consolidation_run_id":run_id, "generated_at":now, "locale":locale, "persona_applied":false, "profile_projection_applied":false});
    if scope == "project" {
        source["project_id"] = project_id.unwrap_or_default().into();
        source["project_name"] = project_name.unwrap_or_default().into();
    }
    json!({"moment":moment, "title":title, "description":description, "suggestions":suggestions, "source":source, "raw_text_included":false})
}

fn card(id: &str, title: &str, description: &str, text: &str) -> Value {
    json!({"id":id,"title":title,"description":description,"text":text})
}

fn general_cards_en() -> Vec<Value> {
    vec![
        card(
            "organize-download-folder",
            "Downloads folder cleanup",
            "Butler checks files on this computer and asks before moving them.",
            "Sort my Downloads folder by type. Show me the plan before moving anything.",
        ),
        card(
            "summarize-document",
            "Document summary",
            "Attach or paste a document to get the key points.",
            "Summarize this in a few key points: ",
        ),
        card(
            "draft-reply",
            "Reply draft",
            "Turn a short note into a clear reply.",
            "Draft a reply from this note: ",
        ),
        card(
            "morning-briefing",
            "Morning briefing",
            "Create a daily 8 AM schedule for weather, news, and today's plans.",
            "Create a daily 8 AM schedule with weather, news, and today's plans.",
        ),
    ]
}
fn general_cards_ko() -> Vec<Value> {
    vec![
        card(
            "organize-download-folder",
            "다운로드 폴더 정리하기",
            "이 컴퓨터의 파일을 살펴보고 옮기기 전에 묻습니다.",
            "다운로드 폴더를 종류별로 정리해줘. 옮기기 전에 계획부터 보여줘.",
        ),
        card(
            "summarize-document",
            "문서 요약하기",
            "첨부하거나 붙여 넣은 문서의 핵심을 정리합니다.",
            "이 내용을 핵심만 요약해줘: ",
        ),
        card(
            "draft-reply",
            "답장 초안 쓰기",
            "짧은 메모를 바탕으로 답장 초안을 씁니다.",
            "이 메모로 답장 초안을 써줘: ",
        ),
        card(
            "morning-briefing",
            "매일 아침 브리핑 받기",
            "날씨·뉴스·일정을 8시에 전하는 예약 작업을 만듭니다.",
            "매일 아침 8시에 날씨와 뉴스, 오늘 일정을 알려주는 예약 작업을 만들어줘.",
        ),
    ]
}
fn project_cards_en(name: &str) -> Vec<Value> {
    vec![
        card(
            "review-commits",
            "Check the risky parts first",
            "Recent changes can show the verification points worth looking at before continuing.",
            "Review recent changes for risks and missing validation.",
        ),
        card(
            "today-plan",
            "Set today's order",
            "Open work is easier to continue when it is arranged into a small sequence.",
            "Turn today's remaining work into an execution order.",
        ),
        card(
            "project-blockers",
            "Mark what is stuck",
            &format!("Narrowing the stalled points in {name} keeps the next step clearer."),
            &format!("Find the blocked points in {name}."),
        ),
        card(
            "briefing-seed",
            "Bring back the loose notes",
            "Ideas and notes can become usable cards before they drift out of view.",
            "Turn leftover ideas into work cards.",
        ),
    ]
}
fn project_cards_ko(name: &str) -> Vec<Value> {
    vec![
        card(
            "review-commits",
            "위험한 부분 먼저 보기",
            "최근 변경사항에서 놓친 검증과 되돌아볼 지점을 찾습니다.",
            "최근 변경사항의 위험과 빠진 검증을 훑어줘",
        ),
        card(
            "today-plan",
            "오늘의 순서 세우기",
            "열린 일들을 실행 가능한 순서로 다시 얇게 펼칩니다.",
            "오늘 이어갈 일을 실행 순서로 정리해줘",
        ),
        card(
            "project-blockers",
            "막힌 곳에 표시하기",
            &format!("{name} 안에서 결정이 멈춘 지점을 좁힙니다."),
            &format!("{name}에서 막힌 지점을 찾아줘"),
        ),
        card(
            "briefing-seed",
            "남겨둔 생각 꺼내기",
            "아이디어와 메모를 다음 행동으로 옮길 수 있게 접습니다.",
            "남겨둔 아이디어를 작업 카드로 바꿔줘",
        ),
    ]
}

#[cfg(test)]
mod tests;
