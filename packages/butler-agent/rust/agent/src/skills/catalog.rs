use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;

use super::{
    SkillError, SkillProjectView, SkillSettingsView, SkillSummary, SkillValidationCounts,
    SkillValidationIssueView, SkillValidationView,
};

#[derive(Clone, Debug, Serialize)]
pub(crate) struct SkillDefinition {
    pub name: String,
    pub description: String,
    pub applicability: String,
    #[serde(skip)]
    pub model: Option<String>,
    pub allowed_tools: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_context_command: Option<String>,
    pub dispatch: String,
    pub review: String,
    pub reporting: String,
    #[serde(skip)]
    pub file_path: PathBuf,
    pub instructions: String,
    pub user_invocable: bool,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct SkillValidationIssue {
    #[serde(rename = "filePath")]
    pub file_path: String,
    pub message: String,
}

pub(super) fn runtime(
    home: &Path,
    data: &Path,
    project: Option<&str>,
) -> Result<Vec<SkillDefinition>, SkillError> {
    let mut skills = load(&core_dir(home))?;
    skills.extend(load(&user_dir(data))?);
    if let Some(project) = project {
        skills.extend(load(&project_dir(data, project))?);
    }
    Ok(skills)
}

pub(super) fn settings(
    home: &Path,
    data: &Path,
    projects: Vec<(String, String)>,
) -> Result<SkillSettingsView, SkillError> {
    let core = summaries(load(&core_dir(home))?, "core", None);
    let user = summaries(load(&user_dir(data))?, "user", None);
    let mut views = Vec::with_capacity(projects.len());
    for (id, display_name) in projects {
        let skills = summaries(load(&project_dir(data, &id))?, "project", Some(&id));
        views.push(SkillProjectView {
            id,
            display_name,
            skills,
        });
    }
    Ok(SkillSettingsView {
        storage_root: data.join("skills").to_string_lossy().into_owned(),
        core,
        user,
        projects: views,
    })
}

pub(super) fn cli_settings(
    resources: &Path,
    data: &Path,
    project_ids: Option<Vec<String>>,
) -> Result<SkillSettingsView, SkillError> {
    let projects = project_ids
        .map(Ok)
        .unwrap_or_else(|| discover_projects(data))?
        .into_iter()
        .map(|id| (id.clone(), id))
        .collect();
    settings(resources, data, projects)
}

pub(super) fn validation(
    resources: &Path,
    data: &Path,
    project_ids: Option<Vec<String>>,
) -> Result<SkillValidationView, SkillError> {
    let core = load(&core_dir(resources))?;
    let user = load(&user_dir(data))?;
    let project_ids = project_ids
        .map(Ok)
        .unwrap_or_else(|| discover_projects(data))?;
    let mut project_count = 0;
    let mut issues = scoped_issues(&core, "core", None);
    issues.extend(scoped_issues(&user, "user", None));
    for project_id in project_ids {
        let skills = load(&project_dir(data, &project_id))?;
        project_count += skills.len();
        issues.extend(scoped_issues(&skills, "project", Some(&project_id)));
    }
    Ok(SkillValidationView {
        ok: issues.is_empty(),
        counts: SkillValidationCounts {
            core: core.len(),
            user: user.len(),
            project: project_count,
        },
        issues,
    })
}

fn discover_projects(data: &Path) -> Result<Vec<String>, SkillError> {
    let root = data.join("skills/projects");
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(SkillError::Io(error)),
    };
    let mut projects = Vec::new();
    for entry in entries {
        let entry = entry.map_err(SkillError::Io)?;
        if entry.file_type().map_err(SkillError::Io)?.is_dir() {
            projects.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    Ok(projects)
}

fn scoped_issues(
    skills: &[SkillDefinition],
    source: &'static str,
    project_id: Option<&str>,
) -> Vec<SkillValidationIssueView> {
    validate(skills)
        .into_iter()
        .map(|issue| SkillValidationIssueView {
            file_path: issue.file_path,
            message: issue.message,
            source,
            project_id: project_id.map(str::to_owned),
        })
        .collect()
}

pub(super) fn load(root: &Path) -> Result<Vec<SkillDefinition>, SkillError> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(SkillError::Io(error)),
    };
    let mut skills = Vec::new();
    for entry in entries {
        let entry = entry.map_err(SkillError::Io)?;
        if !entry.file_type().map_err(SkillError::Io)?.is_dir() {
            continue;
        }
        if let Some(skill) = read(&entry.path().join("SKILL.md"))? {
            skills.push(skill);
        }
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(skills)
}

pub(crate) fn validate(skills: &[SkillDefinition]) -> Vec<SkillValidationIssue> {
    let mut names = HashSet::new();
    let mut issues = Vec::new();
    for skill in skills {
        let path = skill.file_path.to_string_lossy().into_owned();
        let mut add = |message: &str| {
            issues.push(SkillValidationIssue {
                file_path: path.clone(),
                message: message.to_owned(),
            });
        };
        if !names.insert(&skill.name) {
            add(&format!("duplicate skill name: {}", skill.name));
        }
        if skill.description.trim().is_empty() {
            add("description is required");
        }
        if skill.applicability.trim().is_empty() {
            add("applicability is required");
        }
        if skill.allowed_tools.is_empty() {
            add("allowed-tools are required");
        }
        if skill.reporting.trim().is_empty() {
            add("reporting is required");
        }
        if skill.instructions.trim().is_empty() {
            add("instructions body is required");
        }
    }
    issues
}

pub(super) fn summary(
    skill: SkillDefinition,
    source: &'static str,
    project: Option<&str>,
) -> SkillSummary {
    SkillSummary {
        name: skill.name,
        description: skill.description,
        applicability: skill.applicability,
        source,
        project_id: project.map(str::to_owned),
        file_path: skill.file_path.to_string_lossy().into_owned(),
        user_invocable: skill.user_invocable,
    }
}

fn summaries(
    skills: Vec<SkillDefinition>,
    source: &'static str,
    project: Option<&str>,
) -> Vec<SkillSummary> {
    skills
        .into_iter()
        .map(|skill| summary(skill, source, project))
        .collect()
}

fn read(path: &Path) -> Result<Option<SkillDefinition>, SkillError> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(SkillError::Io(error)),
    };
    let (metadata, body) = frontmatter(&content);
    let value = |key: &str| {
        metadata
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    };
    let Some(name) = value("name") else {
        return Ok(None);
    };
    let normalize = |value: Option<&str>, accepted: &[&str]| {
        value
            .filter(|value| accepted.contains(value))
            .unwrap_or("none")
            .to_owned()
    };
    Ok(Some(SkillDefinition {
        name: name.to_owned(),
        description: value("description").unwrap_or("").to_owned(),
        applicability: value("applicability").unwrap_or("").to_owned(),
        model: value("model").map(str::to_owned),
        allowed_tools: value("allowed-tools")
            .unwrap_or("")
            .split(',')
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
            .collect(),
        native_command: None,
        native_context_command: None,
        dispatch: normalize(value("dispatch"), &["none", "direct", "planned", "auto"]),
        review: normalize(value("review"), &["none", "recommended", "required"]),
        reporting: value("reporting").unwrap_or("").to_owned(),
        file_path: path.to_owned(),
        instructions: body.trim().to_owned(),
        user_invocable: value("user-invocable") == Some("true"),
    }))
}

fn frontmatter(content: &str) -> (Vec<(String, String)>, &str) {
    let Some(rest) = content.strip_prefix("---\n") else {
        return (Vec::new(), content);
    };
    let Some((head, body)) = rest.split_once("\n---\n") else {
        return (Vec::new(), content);
    };
    let fields = head
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            Some((
                key.trim().to_owned(),
                value.trim().trim_matches(['\'', '"']).to_owned(),
            ))
        })
        .collect();
    (fields, body)
}

pub(super) fn safe_name(value: &str) -> String {
    value
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_owned()
}
pub(super) fn user_dir(data: &Path) -> PathBuf {
    data.join("skills/default")
}
pub(super) fn project_dir(data: &Path, id: &str) -> PathBuf {
    data.join("skills/projects").join(safe_name(id))
}
fn core_dir(resources: &Path) -> PathBuf {
    resources.join("skills")
}
