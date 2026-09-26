//! Operator CLI adapter for the single native skill authority.

mod output;

use std::{ffi::OsString, path::PathBuf};

use serde::Serialize;
use serde_json::json;

use super::ResolvedInstallation;
use crate::skills::{NativeSkills, SkillError, SkillSettingsView, StagedSkillArchive};
use output::{CommandError, failure, render_error, render_success};

pub use output::NativeSkillCliResult;

struct Options {
    args: Vec<String>,
    data: Option<String>,
    json: bool,
    quiet: bool,
}

pub async fn run_native_skills_cli(
    installation: ResolvedInstallation,
    raw_args: Vec<OsString>,
) -> NativeSkillCliResult {
    let options = match parse(raw_args) {
        Ok(value) => value,
        Err(error) => return render_error(false, "butler skills", error),
    };
    let command = command_string(&options.args);
    let data_root = match resolve_data_root(&installation, options.data.as_deref()) {
        Ok(value) => value,
        Err(error) => return render_error(options.json, &command, error),
    };
    let skills = NativeSkills::new(installation.resources().to_owned(), data_root);
    let outcome = execute(&skills, &options).await;
    skills.close().await;
    match outcome {
        Ok((command, data, human)) => render_success(&options, command, data, &human),
        Err(error) => render_error(options.json, &command, error),
    }
}

async fn execute(
    skills: &NativeSkills,
    options: &Options,
) -> Result<(&'static str, serde_json::Value, String), CommandError> {
    let subcommand = options.args.get(1).map(String::as_str).unwrap_or("list");
    match subcommand {
        "list" => list(skills, options).await,
        "inspect" | "show" => inspect(skills, options).await,
        "import" => import(skills, options).await,
        "validate" => validate(skills, options).await,
        other => Err(failure(
            "unknown_command",
            format!("unknown skills command: {other}"),
            2,
        )),
    }
}

async fn list(
    skills: &NativeSkills,
    options: &Options,
) -> Result<(&'static str, serde_json::Value, String), CommandError> {
    let view = skills
        .cli_settings(project_values(&options.args))
        .await
        .map_err(skill_failure)?;
    let mut lines = vec![names("Core", &view.core), names("User", &view.user)];
    lines.extend(
        view.projects
            .iter()
            .map(|project| names(&format!("Project {}", project.id), &project.skills)),
    );
    Ok(("butler skills list", value(&view)?, lines.join("\n")))
}

async fn inspect(
    skills: &NativeSkills,
    options: &Options,
) -> Result<(&'static str, serde_json::Value, String), CommandError> {
    let name = options
        .args
        .get(2)
        .or_else(|| option_value(&options.args, "--name"))
        .ok_or_else(|| failure("invalid_arguments", "skills inspect requires <name>", 2))?;
    let view = skills
        .cli_settings(project_values(&options.args))
        .await
        .map_err(skill_failure)?;
    let matches: Vec<_> = flattened(&view)
        .into_iter()
        .filter(|skill| skill.name == *name)
        .collect();
    if matches.is_empty() {
        return Err(failure("not_found", format!("skill not found: {name}"), 1));
    }
    let human = matches
        .iter()
        .map(|skill| {
            let scope = skill
                .project_id
                .as_ref()
                .map(|id| format!("{}:{id}", skill.source))
                .unwrap_or_else(|| skill.source.to_owned());
            format!(
                "{} ({scope})\n{}\n{}",
                skill.name, skill.description, skill.file_path
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    Ok(("butler skills inspect", json!({ "skills": matches }), human))
}

async fn import(
    skills: &NativeSkills,
    options: &Options,
) -> Result<(&'static str, serde_json::Value, String), CommandError> {
    let path = options
        .args
        .get(2)
        .or_else(|| option_value(&options.args, "--zip"))
        .or_else(|| option_value(&options.args, "--file"))
        .ok_or_else(|| failure("invalid_arguments", "skills import requires <zip-path>", 2))?;
    let source = PathBuf::from(path);
    if !source.exists() {
        return Err(failure(
            "not_found",
            format!("zip file not found: {path}"),
            1,
        ));
    }
    let root = std::env::temp_dir().join(format!("butler-skill-import-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).map_err(io_failure)?;
    let staged = StagedSkillArchive::new(
        source
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("skill.zip")
            .to_owned(),
        root,
    );
    std::fs::copy(&source, staged.path()).map_err(io_failure)?;
    let result = skills
        .import(staged, option_value(&options.args, "--project").cloned())
        .await
        .map_err(skill_failure)?;
    let human = if result.imported.is_empty() {
        "No skills imported.".to_owned()
    } else {
        format!(
            "Imported skills: {}",
            result
                .imported
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    Ok(("butler skills import", value(&result)?, human))
}

async fn validate(
    skills: &NativeSkills,
    options: &Options,
) -> Result<(&'static str, serde_json::Value, String), CommandError> {
    let result = skills
        .validate_settings(project_values(&options.args))
        .await
        .map_err(skill_failure)?;
    if !result.ok {
        let data = value(&result)?;
        if options.json {
            return Err(CommandError {
                code: "health_failed".to_owned(),
                message: format!("{} skill validation issue(s).", result.issues.len()),
                exit_code: 3,
                data: Some(Box::new(data)),
            });
        }
        return Err(CommandError {
            code: "health_failed".to_owned(),
            message: result
                .issues
                .iter()
                .map(|issue| {
                    let scope = issue
                        .project_id
                        .as_ref()
                        .map(|id| format!("{}:{id}", issue.source))
                        .unwrap_or_else(|| issue.source.to_owned());
                    format!("{scope} {}: {}", issue.file_path, issue.message)
                })
                .collect::<Vec<_>>()
                .join("\n"),
            exit_code: 3,
            data: None,
        });
    }
    let human = format!(
        "Skill validation passed.\ncore={} user={} project={}",
        result.counts.core, result.counts.user, result.counts.project
    );
    Ok(("butler skills validate", value(&result)?, human))
}

fn parse(raw_args: Vec<OsString>) -> Result<Options, CommandError> {
    let raw = raw_args
        .into_iter()
        .map(|arg| {
            arg.into_string()
                .map_err(|_| failure("invalid_arguments", "arguments must be UTF-8", 2))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut args = Vec::new();
    let mut data = None;
    let mut json = false;
    let mut quiet = false;
    let mut index = 0;
    while index < raw.len() {
        match raw[index].as_str() {
            "--data" => {
                let value = raw.get(index + 1).filter(|value| !value.starts_with("--"));
                let Some(value) = value else {
                    return Err(failure("invalid_arguments", "--data requires a path", 2));
                };
                data = Some(value.clone());
                index += 2;
            }
            "--json" => {
                json = true;
                index += 1;
            }
            "--quiet" | "--silent" => {
                quiet = true;
                index += 1;
            }
            "--verbose" | "--yes" | "--non-interactive" => index += 1,
            "--home" => {
                return Err(failure(
                    "invalid_arguments",
                    "--home cannot override immutable installation resources",
                    2,
                ));
            }
            _ => {
                args.push(raw[index].clone());
                index += 1;
            }
        }
    }
    Ok(Options {
        args,
        data,
        json,
        quiet,
    })
}

fn resolve_data_root(
    installation: &ResolvedInstallation,
    explicit: Option<&str>,
) -> Result<PathBuf, CommandError> {
    let requested = explicit
        .map(expand_home)
        .or_else(|| {
            std::env::var("BUTLER_DATA")
                .ok()
                .filter(|value| !value.is_empty())
                .map(|value| expand_home(&value))
        })
        .unwrap_or_else(|| user_home().join(".butler"));
    installation
        .validate_data_root(&requested)
        .map_err(|message| failure("native_path_configuration_invalid", message, 2))
}

fn expand_home(value: &str) -> PathBuf {
    if value == "~" {
        return user_home();
    }
    value
        .strip_prefix("~/")
        .map(|rest| user_home().join(rest))
        .unwrap_or_else(|| PathBuf::from(value))
}

fn user_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn project_values(args: &[String]) -> Option<Vec<String>> {
    let values: Vec<_> = args
        .iter()
        .enumerate()
        .filter(|(_, arg)| arg.as_str() == "--project")
        .filter_map(|(index, _)| args.get(index + 1))
        .filter(|value| !value.starts_with("--"))
        .cloned()
        .collect();
    (!values.is_empty()).then_some(values)
}

fn option_value<'a>(args: &'a [String], name: &str) -> Option<&'a String> {
    let index = args.iter().position(|arg| arg == name)?;
    args.get(index + 1).filter(|value| !value.starts_with("--"))
}

fn flattened(view: &SkillSettingsView) -> Vec<&crate::skills::SkillSummary> {
    view.core
        .iter()
        .chain(&view.user)
        .chain(view.projects.iter().flat_map(|project| &project.skills))
        .collect()
}

fn names(label: &str, skills: &[crate::skills::SkillSummary]) -> String {
    if skills.is_empty() {
        format!("{label}: none")
    } else {
        format!(
            "{label}: {}",
            skills
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
    }
}

fn value(input: &impl Serialize) -> Result<serde_json::Value, CommandError> {
    serde_json::to_value(input)
        .map_err(|error| failure("skills_output_failed", error.to_string(), 1))
}

fn command_string(args: &[String]) -> String {
    format!("butler {}", args.join(" ")).trim().to_owned()
}

fn skill_failure(error: SkillError) -> CommandError {
    failure(error.code, error.message, 1)
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn io_failure(error: std::io::Error) -> CommandError {
    failure("skills_io_failed", error.to_string(), 1)
}
