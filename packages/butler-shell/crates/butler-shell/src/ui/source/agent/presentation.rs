//! A synchronous, UI-thread projection of the most recently requested session controls.
use super::super::{ComposerContext, Fetch};
use butler_shell_client::{Error, ShellClient};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

#[derive(Default)]
pub(super) struct Presentation {
    generation: Cell<u64>,
    value: RefCell<Option<ComposerContext>>,
}
impl Presentation {
    pub(super) fn remember<T: 'static>(
        self: &Rc<Self>,
        fetch: Fetch<(T, ComposerContext)>,
    ) -> Fetch<T> {
        let generation = self.generation.get() + 1;
        self.generation.set(generation);
        let this = self.clone();
        Box::pin(async move {
            let (result, context) = fetch.await?;
            if this.generation.get() == generation {
                *this.value.borrow_mut() = Some(context);
            }
            Ok(result)
        })
    }
    pub(super) fn initial<T: 'static>(
        self: &Rc<Self>,
        fetch: Fetch<(T, ComposerContext)>,
    ) -> Fetch<T> {
        let this = self.clone();
        Box::pin(async move {
            let (result, context) = fetch.await?;
            if this.generation.get() == 0 {
                *this.value.borrow_mut() = Some(context);
            }
            Ok(result)
        })
    }
    pub(super) fn get(&self) -> ComposerContext {
        self.value
            .borrow()
            .clone()
            .unwrap_or_else(|| ComposerContext {
                permission: "".into(),
                model: "".into(),
                effort: "".into(),
            })
    }
}
pub(super) async fn read(client: &ShellClient, session: &str) -> Result<ComposerContext, Error> {
    let raw = client.session_controls(session).await?;
    let controls = &raw["controls"];
    Ok(ComposerContext {
        permission: super::convert::string(controls, "access_mode")?
            .to_owned()
            .into(),
        model: super::convert::string(controls, "model")?.to_owned().into(),
        effort: super::convert::string(controls, "reasoning_effort")?
            .to_owned()
            .into(),
    })
}
