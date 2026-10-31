//! The profile section port of prompt assembly.

use std::future::Future;
use std::pin::Pin;

use super::ContextResult;

pub type ContextFuture<'a, T> = Pin<Box<dyn Future<Output = ContextResult<T>> + Send + 'a>>;

pub struct PromptProjectionInput<'a> {
    pub session_id: &'a str,
    pub project_id: Option<&'a str>,
}

pub trait ProfilePromptPort: Send + Sync {
    fn naming_profile<'a>(
        &'a self,
        input: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Option<String>>;
    fn runtime_profile<'a>(
        &'a self,
        input: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Option<String>>;
    fn first_chat_onboarding<'a>(
        &'a self,
        input: &'a PromptProjectionInput<'a>,
        locale: &'a str,
    ) -> ContextFuture<'a, Option<String>>;
}
