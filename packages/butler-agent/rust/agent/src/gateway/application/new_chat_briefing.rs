//! Public New Chat Briefing projection over Cognition artifacts and App state.

use chrono::DateTime;
use serde_json::{Value, json};

use super::AppApplication;
use crate::gateway::GatewayApplicationError;
use crate::{cognition, profile};

impl AppApplication {
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
                    })?,
            )
        } else {
            None
        };
        let data_root = self.butler_data.clone();
        let now = self.dependencies.identity_clock.now_iso();
        tokio::task::spawn_blocking(move || {
            let epoch_ms = DateTime::parse_from_rfc3339(&now)
                .map_err(|_| GatewayApplicationError::Internal)?
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
                "project"
            } else {
                "general"
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
                scope,
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
        .map_err(|_| GatewayApplicationError::Internal)?
    }
}

fn local_minute(epoch_ms: i64) -> Result<u16, GatewayApplicationError> {
    let path = match std::env::var("TZ") {
        Ok(zone) if zone.is_empty() => None,
        Ok(zone) => {
            let zone = zone.strip_prefix(':').unwrap_or(&zone);
            if zone.starts_with('/') {
                Some(std::path::PathBuf::from(zone))
            } else if !zone.split('/').any(|part| matches!(part, "" | "." | "..")) {
                Some(std::path::Path::new("/usr/share/zoneinfo").join(zone))
            } else {
                return Err(GatewayApplicationError::Internal);
            }
        }
        Err(_) => Some(std::path::PathBuf::from("/etc/localtime")),
    };
    let offset = if let Some(path) = path {
        let bytes = std::fs::read(path).map_err(|_| GatewayApplicationError::Internal)?;
        let zone =
            tz::TimeZone::from_tz_data(&bytes).map_err(|_| GatewayApplicationError::Internal)?;
        zone.find_local_time_type(epoch_ms.div_euclid(1000))
            .map_err(|_| GatewayApplicationError::Internal)?
            .ut_offset()
    } else {
        0
    };
    let wall = epoch_ms + i64::from(offset) * 1000;
    // A day has 1440 minutes, so this always fits.
    Ok(u16::try_from(wall.rem_euclid(86_400_000) / 60_000).unwrap_or_default())
}

fn generated_view(artifact: &Value, moment: &str, bucket: &str) -> Value {
    let general = artifact["scope"] == "general";
    let variants = artifact.get("title_variants");
    let title = if general {
        variants.and_then(|value| value[bucket].as_str())
    } else {
        None
    }
    .or_else(|| artifact["title"].as_str())
    .unwrap_or_default();
    let suggestions = artifact["suggestions"].as_array().into_iter().flatten()
        .map(|item| json!({"id":item["id"], "title":item["title"], "description":item["description"], "text":item["text"]}))
        .collect::<Vec<_>>();
    let mut source = json!({
        "scope":artifact["scope"], "content_origin":"generated",
        "consolidation_run_id":artifact["source"]["consolidation_run_id"],
        "generated_at":artifact["source"]["generated_at"], "locale":artifact["locale"],
        "persona_applied":artifact["source"]["persona_applied"],
        "profile_projection_applied":artifact["source"]["profile_projection_id"].as_str().is_some_and(|id| !id.is_empty())
    });
    if let Some(id) = artifact["project_id"].as_str() {
        source["project_id"] = id.into();
    }
    if let Some(name) = artifact["project_name"].as_str() {
        source["project_name"] = name.into();
    }
    json!({
        "moment":if general && variants.is_some() { moment } else { artifact["moment"].as_str().unwrap_or_default() },
        "title":title, "description":artifact["description"], "suggestions":suggestions,
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
        "onboarding" if ko => ("온보딩".to_owned(), "반갑습니다. 당신을 모시게 되어 기쁩니다.".to_owned(), "AI 에이전트 집사 버틀러를 선택해주셔서 감사합니다. 시작하기에 앞서 간단하게 당신에 대해 알려주세요.".to_owned(), vec![card("butler-onboarding", "버틀러와 알아가기", "버틀러를 사용하기에 앞서 기본적인 설정을 진행합니다.", "버틀러를 사용하기에 앞서 기본적인 설정을 진행하자.")]),
        "onboarding" => ("Onboarding".to_owned(), "Pleased to meet you. It will be my honor to serve.".to_owned(), "Thank you for choosing Butler, your AI agent butler. Before we begin, please tell me a little about yourself.".to_owned(), vec![card("butler-onboarding", "Get acquainted with Butler", "Set up the basics before using Butler.", "Let's set up the basics before I start using Butler.")]),
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
            "daily-briefing",
            "Worth a short look today",
            "A compact pass over notable news and public sources can make the day easier to place.",
            "Give me a short briefing on today's notable news and public sources.",
        ),
        card(
            "open-source-trends",
            "Open source getting attention",
            "Looking at projects gaining attention can surface useful ideas and patterns.",
            "Summarize recent open-source projects by why they are gaining attention and where they may be useful.",
        ),
        card(
            "search-strategy",
            "How to split the search",
            "Splitting a broad question helps separate quick scanning from deeper verification.",
            "Lay out a way to split broad research into quick search and deeper verification.",
        ),
        card(
            "web-standards-rendering",
            "Why browsers render differently",
            "Comparing CSS specs with browser behavior can make rendering issues easier to narrow down.",
            "Compare CSS specs with browser rendering differences.",
        ),
    ]
}
fn general_cards_ko() -> Vec<Value> {
    vec![
        card(
            "daily-briefing",
            "오늘 볼 만한 소식",
            "주요 이슈와 공개 자료를 짧게 훑어두면 하루의 방향을 잡는 데 도움이 됩니다.",
            "오늘 볼 만한 주요 이슈와 공개 자료를 짧게 브리핑해줘.",
        ),
        card(
            "open-source-trends",
            "요즘 뜨는 오픈소스",
            "최근 주목받는 오픈소스 프로젝트를 살펴보고 영감을 얻을 수 있도록 정리해봐요.",
            "최근 주목받는 오픈소스 프로젝트를 이유와 활용처 중심으로 정리해줘.",
        ),
        card(
            "search-strategy",
            "검색어를 어떻게 나눌까",
            "넓은 질문을 몇 갈래로 나누면 빠르게 훑을 부분과 깊게 볼 부분을 더 잘 구분할 수 있습니다.",
            "넓은 검색 요청을 빠른 검색과 깊은 검색으로 나누는 기준을 정리해줘.",
        ),
        card(
            "web-standards-rendering",
            "브라우저마다 다르게 보이는 이유",
            "CSS 스펙과 실제 구현 차이를 같이 보면 UI 문제가 어디에서 생기는지 더 빨리 좁힐 수 있습니다.",
            "CSS 스펙과 브라우저별 렌더링 차이를 비교해서 설명해줘.",
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
