use crate::btcc::{ContextAssembly, ContextSection, TurnRequest};
use crate::context::{ContextError, ContextResult};
use crate::workspace::{SessionRole, StoredSessionBinding};

use super::cache::live_configuration_hash;
use super::files::{
    active_persona, bounded_persona, build_rules_content, read_config, read_text_if_exists,
    resolve_language, resource_path,
};
use super::runtime::{
    RuntimeStateInput, attachment_references, current_attachments, current_input, runtime_state,
    section,
};
use super::{PromptAssembler, PromptProjectionInput, SharedAssemblyInput};

impl PromptAssembler {
    pub(super) fn runtime_system_context(&self) -> ContextResult<Vec<ContextSection>> {
        let mut sections = Vec::new();
        push(
            &mut sections,
            "runtime-system-contract",
            "Runtime System Contract",
            read_text_if_exists(&resource_path(
                &self.paths,
                &["prompts", "runtime-system-contract.md"],
            ))?,
            "static_context",
            "profile",
            "user",
        );
        Ok(sections)
    }

    pub(super) fn static_context(
        &self,
        binding: &StoredSessionBinding,
    ) -> ContextResult<Vec<ContextSection>> {
        let mut sections = self.runtime_system_context()?;
        let (title, file) = if matches!(binding.role, SessionRole::Butler) {
            ("Butler Role Rules", "butler.md")
        } else {
            ("Steward Role Rules", "steward.md")
        };
        push(
            &mut sections,
            "role",
            title,
            read_text_if_exists(&resource_path(&self.paths, &["prompts", file]))?,
            "static_context",
            "profile",
            "user",
        );
        Ok(sections)
    }

    pub(super) async fn runtime_assembly(
        &self,
        binding: &StoredSessionBinding,
        request: &TurnRequest,
    ) -> ContextResult<ContextAssembly> {
        let projection = PromptProjectionInput {
            session_id: &binding.session_id,
            project_id: binding.project_id.as_deref(),
        };
        let mut role_configuration = Vec::new();
        if !matches!(binding.role, SessionRole::Butler) {
            push(
                &mut role_configuration,
                "steward-config",
                "Steward Prompt",
                read_text_if_exists(&self.paths.data_root.join("config").join("steward.md"))?,
                "live_configuration",
                "optional_hot_cache",
                if binding.project_id.is_some() {
                    "project"
                } else {
                    "session"
                },
            );
        }
        if matches!(binding.role, SessionRole::Butler)
            && let Some(persona) = active_persona(&self.paths.data_root)?
        {
            role_configuration.push(active_persona_reminder(&persona));
        }
        check_cancelled(request)?;
        push(
            &mut role_configuration,
            "personalization-profile",
            "Personalization Profile",
            self.dependencies
                .profile
                .naming_profile(&projection)
                .await?,
            "live_configuration",
            "profile",
            "user",
        );
        let onboarding = if matches!(binding.role, SessionRole::Butler) {
            check_cancelled(request)?;
            let config = read_config(&self.paths.data_root)?;
            let persona = active_persona(&self.paths.data_root)?;
            let language = resolve_language(
                self.environment.response_language_override.as_deref(),
                self.environment.response_language.as_deref(),
                &config,
                persona.as_deref(),
            );
            self.dependencies
                .profile
                .first_chat_onboarding(&projection, language)
                .await?
        } else {
            None
        };
        check_cancelled(request)?;
        let runtime_profile = self
            .dependencies
            .profile
            .runtime_profile(&projection)
            .await?;
        push(
            &mut role_configuration,
            "profile-projection",
            "Profile Projection",
            runtime_profile,
            "live_configuration",
            "profile",
            "user",
        );
        let mut common = self
            .shared_assembly(SharedAssemblyInput {
                binding,
                request,
                role_configuration,
            })
            .await?;
        push(
            &mut common.runtime_state,
            "first-chat-onboarding",
            "First-Chat Onboarding",
            onboarding,
            "runtime_state",
            "profile",
            "user",
        );

        check_cancelled(request)?;
        let project_memory = self
            .dependencies
            .cognition
            .project_capsule(&projection)
            .await?;
        check_cancelled(request)?;
        let hot_cache = self
            .dependencies
            .cognition
            .generation_hot_cache(&projection)
            .await?;
        check_cancelled(request)?;
        let continuity = self
            .dependencies
            .cognition
            .session_continuity(&projection)
            .await?;
        push(
            &mut common.retrieved_context,
            "hot-cache",
            "Hot Cache",
            hot_cache,
            "retrieved_context",
            "optional_hot_cache",
            if binding.project_id.is_some() {
                "project"
            } else {
                "user"
            },
        );
        push(
            &mut common.retrieved_context,
            "session-continuity",
            "Session Continuity",
            continuity,
            "retrieved_context",
            "optional_hot_cache",
            "session",
        );
        push(
            &mut common.retrieved_context,
            "project-memory",
            "Project Memory",
            project_memory,
            "retrieved_context",
            "optional_hot_cache",
            "project",
        );
        common.static_context = self.static_context(binding)?;
        if let Some(section) = current_attachments(request, binding) {
            common.working_context.push(section);
        }
        common.current_input.push(current_input(request));
        common.references = attachment_references(request);
        Ok(common)
    }

    pub(super) async fn shared_assembly(
        &self,
        input: SharedAssemblyInput<'_>,
    ) -> ContextResult<ContextAssembly> {
        let mut live = Vec::new();
        let eol = match read_text_if_exists(&self.paths.data_root.join("eol.md"))? {
            Some(content) => Some(content),
            None => read_text_if_exists(&resource_path(&self.paths, &["eol.md"]))?,
        };
        push(
            &mut live,
            "eol",
            "Butler Operating Ethos / EOL",
            eol,
            "live_configuration",
            "profile",
            "user",
        );
        push(
            &mut live,
            "rules",
            "Active Rules",
            build_rules_content(&self.paths.cognition_root.join("rules"))?,
            "live_configuration",
            "mandatory_hot_cache",
            "user",
        );
        let projection = PromptProjectionInput {
            session_id: &input.binding.session_id,
            project_id: input.binding.project_id.as_deref(),
        };
        check_cancelled(input.request)?;
        for feedback in self
            .dependencies
            .cognition
            .scoped_feedback(&projection)
            .await?
        {
            if feedback.content.is_empty() {
                continue;
            }
            let id = if feedback.scope_kind == "user" {
                "feedback-buffer".into()
            } else {
                format!("{}-feedback-buffer", feedback.scope_kind)
            };
            live.push(section(
                &id,
                "Active Feedback Buffer",
                feedback.content,
                "live_configuration",
                "recent_feedback",
                &feedback.scope_kind,
            ));
        }
        live.extend(input.role_configuration);
        let hash = live_configuration_hash(&live)?;
        let config = read_config(&self.paths.data_root)?;
        check_cancelled(input.request)?;
        let status = self
            .dependencies
            .cognition
            .project_capsule_status(input.binding, &input.request.preparation_cancellation)
            .await?;
        let response_config = read_config(&self.paths.data_root)?;
        let response_persona = active_persona(&self.paths.data_root)?;
        let language = resolve_language(
            self.environment.response_language_override.as_deref(),
            self.environment.response_language.as_deref(),
            &response_config,
            response_persona.as_deref(),
        );
        Ok(ContextAssembly {
            static_context: self.runtime_system_context()?,
            live_configuration: live,
            runtime_state: vec![runtime_state(RuntimeStateInput {
                binding: input.binding,
                request: input.request,
                config: &config,
                environment: &self.environment,
                clock: self.dependencies.clock.as_ref(),
                response_language: language,
                live_config_hash: &hash,
                project_status: status,
            })?],
            working_context: Vec::new(),
            retrieved_context: Vec::new(),
            current_input: Vec::new(),
            references: Vec::new(),
            live_config_hash: hash,
        })
    }
}

fn active_persona_reminder(persona: &str) -> ContextSection {
    let persona = bounded_persona(persona);
    let content = [
        "Use this current persona for every user-facing answer in this turn.",
        "Use the configured Assistant Response Language from the Turn Environment by default. Follow the user's explicit request to answer or translate into another language instead.",
        "Preserve the persona's tone and signature speech patterns; translate or adapt that voice into the configured response language, or the language explicitly requested by the user.",
        "For long answers, carry the persona through section bodies and the closing, not only the opening sentence.",
        "Do not let tool, review, or report formatting instructions erase the persona.",
        "",
        &persona,
    ]
    .join("\n");
    section(
        "active-persona-reminder",
        "Active Persona Reminder",
        content,
        "live_configuration",
        "profile",
        "user",
    )
}

fn push(
    sections: &mut Vec<ContextSection>,
    id: &str,
    title: &str,
    content: Option<String>,
    region: &str,
    projection: &str,
    scope: &str,
) {
    if let Some(content) = content.filter(|value| !value.is_empty()) {
        sections.push(section(id, title, content, region, projection, scope));
    }
}

fn check_cancelled(request: &TurnRequest) -> ContextResult<()> {
    if request.preparation_cancellation.is_cancelled() {
        Err(ContextError::new(
            "prompt_assembly_cancelled",
            "Prompt assembly was cancelled",
        ))
    } else {
        Ok(())
    }
}
