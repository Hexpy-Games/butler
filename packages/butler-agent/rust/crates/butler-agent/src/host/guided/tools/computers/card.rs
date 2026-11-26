use super::{GuidedTools, ToolName, admin, error, not_found, rows};
use butler_turn::btcc::{
    OptionKind, QuestionKind, QuestionOption, UserQuestion, UserQuestionAnswer, UserQuestions,
};
use http::Method;
use serde_json::{Map, Value, json};

const FIELDS: [&str; 4] = ["name", "address", "folder", "model"];
pub(super) const CONNECTION_FIELDS: [&str; 2] = ["port", "key_file"];
const KO: Copy = Copy {
    eyebrow: "컴퓨터",
    labels: ["이름", "주소", "폴더", "모델"],
    connection_labels: ["포트", "키 파일"],
    unreachable: "연결할 수 없습니다",
    key_login: "키로 로그인할 수 없습니다",
    name: "컴퓨터 이름",
    address: "SSH 주소 (~/.ssh/config 별칭 사용 가능)",
    folder: "작업 폴더",
    model: "그 컴퓨터에서 쓸 모델",
    follow: "이 기기와 같게",
    none: "설정 안 함",
    saved_key: "저장한 키 · ",
    key_notice: "추가하면 이 기기의 모델 키가 그 컴퓨터로 전달됩니다",
    remove: "삭제",
    forget: "삭제하고 이 컴퓨터 대화에서 나온 기억도 지우기",
};
const EN: Copy = Copy {
    eyebrow: "Computer",
    labels: ["Name", "Address", "Folder", "Model"],
    connection_labels: ["Port", "Key file"],
    unreachable: "Can't connect",
    key_login: "Can't sign in with a key",
    name: "Computer name",
    address: "SSH address (~/.ssh/config aliases work)",
    folder: "Work folder",
    model: "Model for that computer",
    follow: "Same as this device",
    none: "Not set",
    saved_key: "Saved key · ",
    key_notice: "Adding it sends this device's model key to that computer.",
    remove: "Delete",
    forget: "Delete and erase memories from conversations on this computer",
};

struct Copy {
    eyebrow: &'static str,
    labels: [&'static str; 4],
    connection_labels: [&'static str; 2],
    unreachable: &'static str,
    key_login: &'static str,
    name: &'static str,
    address: &'static str,
    folder: &'static str,
    model: &'static str,
    follow: &'static str,
    none: &'static str,
    saved_key: &'static str,
    key_notice: &'static str,
    remove: &'static str,
    forget: &'static str,
}

impl Copy {
    fn title(&self, field: &str, target: Option<&str>) -> String {
        match (field, target, self.eyebrow == KO.eyebrow) {
            ("model", Some(name), true) => format!("{name}에서 쓸 모델"),
            ("model", Some(name), false) => format!("Model for {name}"),
            ("model", None, _) => self.model.into(),
            ("confirm", Some(name), true) => format!(
                "{name}을 삭제할까요? 그 컴퓨터에 올린 버틀러와 모델 설정을 지웁니다. 대화 기록은 남습니다."
            ),
            ("confirm", Some(name), false) => format!(
                "Delete {name}? This removes Butler and its model settings from that computer. Conversation history stays."
            ),
            (field, target, korean) => {
                let title = match field {
                    "name" => self.name,
                    "address" => self.address,
                    _ => self.folder,
                };
                match target {
                    Some(name) if korean => format!("{name}의 {title}"),
                    Some(name) => format!("{title} for {name}"),
                    None => title.into(),
                }
            }
        }
    }
}

pub(super) async fn build(
    owner: &GuidedTools,
    tool: ToolName,
    args: &Map<String, Value>,
) -> Result<UserQuestions, Value> {
    validate(tool, args)?;
    let copy = copy(owner);
    let model = tool == ToolName::ComputerAdd || args.contains_key("model");
    let client = admin(owner).await?;
    let data = client.data(Method::GET, "/computers", None).await?;
    let target = args
        .get("computer")
        .and_then(Value::as_str)
        .map(|target| find_target(rows(&data, "computers"), target))
        .transpose()?;
    let name = target.and_then(|computer| computer["name"].as_str());
    let prefix = target
        .and_then(|computer| computer["id"].as_str())
        .map_or_else(|| tool.as_str().to_owned(), |id| format!("{tool}:{id}"));
    let question = |field: &str, options: Vec<QuestionOption>, allow_custom| UserQuestion {
        id: format!("{prefix}.{field}"),
        eyebrow: FIELDS
            .iter()
            .position(|f| *f == field)
            .map_or_else(|| copy.eyebrow.into(), |index| copy.labels[index].into()),
        title: copy.title(field, name),
        kind: if options.is_empty() {
            QuestionKind::Text
        } else {
            QuestionKind::Single
        },
        options,
        allow_custom,
    };
    if tool == ToolName::ComputerRemove {
        return Ok(UserQuestions {
            questions: vec![question(
                "confirm",
                vec![
                    option("remove:keep", copy.remove, None, false),
                    option("remove:forget", copy.forget, None, false),
                ],
                false,
            )],
        });
    }
    let mut questions = Vec::new();
    for field in &FIELDS[..3] {
        if tool == ToolName::ComputerAdd || args.contains_key(*field) {
            let options = args
                .get(*field)
                .and_then(Value::as_str)
                .filter(|label| label.chars().count() <= 512)
                .map(|label| option("proposed", label, None, true))
                .into_iter()
                .collect();
            questions.push(question(field, options, true));
        }
    }
    if model {
        let credentials = client.data(Method::GET, "/credentials", None).await?;
        questions.push(question(
            "model",
            model_options(
                copy,
                &data["main_model"],
                target,
                args.get("model").and_then(Value::as_str),
                rows(&credentials, "credentials"),
            ),
            false,
        ));
    }
    Ok(UserQuestions { questions }.normalized())
}

fn copy(owner: &GuidedTools) -> &'static Copy {
    let language = owner.binding.response_language.trim().to_ascii_lowercase();
    if matches!(language.as_str(), "" | "ko" | "korean" | "한국어") {
        &KO
    } else {
        &EN
    }
}

pub(super) fn connection(
    owner: &GuidedTools,
    code: &str,
    name: &str,
    args: &Map<String, Value>,
) -> UserQuestions {
    let copy = copy(owner);
    let reason = if code == "ssh_unreachable" {
        copy.unreachable
    } else {
        copy.key_login
    };
    let proposals = [
        args.get("port")
            .and_then(proposed_port)
            .map(|port| port.to_string()),
        args.get("key_file")
            .and_then(Value::as_str)
            .filter(|key| !key.trim().is_empty() && key.chars().count() <= 512)
            .map(str::to_owned),
    ];
    let questions = CONNECTION_FIELDS
        .into_iter()
        .zip(copy.connection_labels)
        .zip(proposals)
        .map(|((field, label), proposal)| {
            let mut options = Vec::new();
            if let Some(proposal) = proposal {
                options.push(option("proposed", &proposal, None, true));
            }
            options.push(option("none", copy.none, None, false));
            UserQuestion {
                id: format!("computer_add:{code}.{field}"),
                eyebrow: label.into(),
                title: if copy.eyebrow == KO.eyebrow {
                    format!("{reason}. {name}의 {label}")
                } else {
                    format!("{reason}. {label} for {name}")
                },
                kind: QuestionKind::Single,
                options,
                allow_custom: true,
            }
        })
        .collect();
    UserQuestions { questions }.normalized()
}

pub(super) fn parse_port(value: &str) -> Option<u16> {
    if !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse::<u16>().ok().filter(|port| *port != 0)
}

fn proposed_port(value: &Value) -> Option<u16> {
    match value {
        Value::String(value) => parse_port(value),
        _ => u16::try_from(value.as_u64()?)
            .ok()
            .filter(|port| *port != 0),
    }
}

fn find_target<'a>(computers: &'a [Value], target: &str) -> Result<&'a Value, Value> {
    let name = target.to_lowercase();
    computers
        .iter()
        .find(|computer| computer["id"] == target)
        .or_else(|| {
            computers.iter().find(|computer| {
                computer["name"]
                    .as_str()
                    .is_some_and(|value| value.to_lowercase() == name)
            })
        })
        .ok_or_else(not_found)
}

fn validate(tool: ToolName, args: &Map<String, Value>) -> Result<(), Value> {
    let valid = args.iter().all(|(field, value)| {
        if tool == ToolName::ComputerAdd && field == "port" {
            return proposed_port(value).is_some();
        }
        let allowed = match tool {
            ToolName::ComputerRemove => field == "computer",
            ToolName::ComputerEdit => field == "computer" || FIELDS.contains(&field.as_str()),
            _ => field == "key_file" || FIELDS.contains(&field.as_str()),
        };
        allowed && value.as_str().is_some_and(|value| !value.trim().is_empty())
    }) && (tool == ToolName::ComputerAdd || args.contains_key("computer"))
        && (tool != ToolName::ComputerEdit || args.len() > 1)
        && args
            .get("model")
            .and_then(Value::as_str)
            .is_none_or(|model| {
                matches!(model, "follow" | "chatgpt" | "none")
                    || model
                        .strip_prefix("key:")
                        .is_some_and(|label| !label.is_empty())
            });
    if valid {
        Ok(())
    } else {
        Err(error("invalid_arguments", "Provide valid computer fields."))
    }
}

fn option(id: &str, label: &str, description: Option<&str>, recommended: bool) -> QuestionOption {
    QuestionOption {
        id: id.into(),
        label: label.into(),
        description: description.map(str::to_owned),
        recommended,
        kind: OptionKind::Answer,
    }
}

fn model_options(
    copy: &Copy,
    main_model: &Value,
    target: Option<&Value>,
    proposal: Option<&str>,
    credentials: &[Value],
) -> Vec<QuestionOption> {
    let mut keys: Vec<_> = credentials.iter().collect();
    keys.sort_by(|a, b| b["updated_at"].as_str().cmp(&a["updated_at"].as_str()));
    let proposed_key = proposal
        .and_then(|s| s.strip_prefix("key:"))
        .and_then(|label| keys.iter().position(|key| key["label"] == label))
        .map(|index| {
            let key = keys.remove(index);
            keys.insert(0, key);
            format!("model:key:{}", key["id"].as_str().unwrap_or_default())
        });
    let recommended = proposed_key
        .or_else(|| {
            proposal
                .filter(|s| !s.starts_with("key:"))
                .map(|value| format!("model:{value}"))
        })
        .or_else(|| {
            if let Some(target) = target {
                let source = &target["model_source"];
                source
                    .as_str()
                    .map(|value| format!("model:{value}"))
                    .or_else(|| source["key"].as_str().map(|id| format!("model:key:{id}")))
            } else {
                Some(
                    match main_model.as_str() {
                        Some("key") => "model:follow",
                        Some("chatgpt") => "model:chatgpt",
                        _ => "model:none",
                    }
                    .into(),
                )
            }
        });
    let choice =
        |id, label, description| option(id, label, description, recommended.as_deref() == Some(id));
    let mut options = vec![
        choice(
            "model:follow",
            copy.follow,
            (*main_model == "key").then_some(copy.key_notice),
        ),
        choice("model:chatgpt", "ChatGPT", None),
        choice("model:none", copy.none, None),
    ];
    options.extend(
        keys.into_iter()
            .filter_map(|key| {
                let id = format!("model:key:{}", key["id"].as_str()?);
                let label = format!("{}{}", copy.saved_key, key["label"].as_str()?);
                (id.chars().count() <= 64 && label.chars().count() <= 512).then(|| {
                    option(
                        &id,
                        &label,
                        Some(copy.key_notice),
                        recommended.as_deref() == Some(id.as_str()),
                    )
                })
            })
            .take(3),
    );
    options
}

pub(super) fn answers(
    tool: ToolName,
    questions: &UserQuestions,
    answers: &[UserQuestionAnswer],
) -> Option<(Option<String>, Map<String, Value>)> {
    let mut target = None;
    let mut fields = std::collections::HashSet::new();
    let mut values = Map::new();
    for question in &questions.questions {
        let (prefix, field) = question.id.split_once('.')?;
        let expected = if tool == ToolName::ComputerRemove {
            &["confirm"][..]
        } else {
            &FIELDS
        };
        if !expected.contains(&field) || !fields.insert(field) {
            return None;
        }
        if tool == ToolName::ComputerAdd {
            if prefix != tool.as_str() {
                return None;
            }
        } else {
            let (kind, id) = prefix.split_once(':')?;
            if kind != tool.as_str()
                || uuid::Uuid::parse_str(id).is_err()
                || target.as_deref().is_some_and(|target| target != id)
            {
                return None;
            }
            target = Some(id.to_owned());
        }
        let answer = answers.iter().find(|answer| answer.id == question.id)?;
        if answer.skipped {
            continue;
        }
        let selected = answer
            .selected
            .first()
            .and_then(|id| question.options.iter().find(|option| &option.id == id));
        let custom = answer
            .custom
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let value = match field {
            "model" => match selected?.id.strip_prefix("model:")? {
                value @ ("follow" | "chatgpt" | "none") => json!(value),
                value => json!({"key":value.strip_prefix("key:")?}),
            },
            "confirm" => match selected?.id.as_str() {
                id @ ("remove:keep" | "remove:forget") => json!(id),
                _ => return None,
            },
            _ => json!(custom.or_else(|| selected.map(|option| option.label.as_str()))?),
        };
        values.insert(field.into(), value);
    }
    if fields.is_empty() || (tool == ToolName::ComputerAdd && fields.len() != FIELDS.len()) {
        return None;
    }
    Some((target, values))
}
