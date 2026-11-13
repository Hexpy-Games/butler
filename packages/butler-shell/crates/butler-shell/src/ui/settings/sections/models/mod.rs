//! Settings: Models (`ModelsSettings.tsx`, and the `modelRoute` of `settingsUIStore`). The page
//! is the models root, model management, or add/edit of one model; the header's breadcrumb
//! (`ModelSettingsTitle.tsx`) is the section's subpage. Leaving a route with unsaved local-model
//! edits is not guarded (F1).
pub(crate) mod local;
pub(crate) mod manage;
mod root;
mod title;
mod workers;

use std::rc::Rc;

use gpui::{
    AnyView, App, AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render,
    SharedString, Window, div,
};

use crate::ui::settings::SectionCtx;
use manage::{AddEditPage, ImageAddPage, ManagementKind, ManagementPage};
use root::RootPage;

/// `SettingsModelRoute`: the models page, management, add, or edit of one model.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ModelRoute {
    Root,
    Management,
    ImageManagement,
    ImageAdd,
    Add,
    Edit(SharedString),
}

/// Moves the models page to a route.
pub(crate) type Navigate = Rc<dyn Fn(ModelRoute, &mut Window, &mut App)>;

/// The page of the current route.
enum Body {
    Root,
    Management(Entity<ManagementPage>),
    AddEdit(Entity<AddEditPage>),
    ImageManagement(Entity<ManagementPage>),
    ImageAdd(Entity<ImageAddPage>),
}

/// `ModelsSettings`: the root page lives as long as the section (its Advanced disclosure keeps
/// its state across routes); the other routes are built when entered.
struct ModelsPage {
    ctx: SectionCtx,
    navigate: Navigate,
    root: Entity<RootPage>,
    body: Body,
}

impl ModelsPage {
    fn new(ctx: SectionCtx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let this = cx.weak_entity();
        let navigate: Navigate = Rc::new(move |route, window, cx| {
            let _ = this.update(cx, |page, cx| page.go(&route, window, cx));
        });
        let root = cx.new(|cx| RootPage::new(ctx.clone(), navigate.clone(), window, cx));
        ctx.set_subpage(
            Some(title::subpage(&ModelRoute::Root, navigate.clone())),
            cx,
        );
        Self {
            ctx,
            navigate,
            root,
            body: Body::Root,
        }
    }

    /// `openModelManagement`, `openModelAdd`, `openModelEdit`, `backModelRoute`.
    fn go(&mut self, route: &ModelRoute, window: &mut Window, cx: &mut Context<Self>) {
        let (ctx, navigate) = (self.ctx.clone(), self.navigate.clone());
        self.body = match route {
            ModelRoute::Root => Body::Root,
            ModelRoute::Management => Body::Management(
                cx.new(|cx| ManagementPage::new(ctx, navigate, ManagementKind::Chat, window, cx)),
            ),
            ModelRoute::ImageManagement => {
                Body::ImageManagement(cx.new(|cx| {
                    ManagementPage::new(ctx, navigate, ManagementKind::Image, window, cx)
                }))
            }
            ModelRoute::ImageAdd => {
                Body::ImageAdd(cx.new(|cx| ImageAddPage::new(ctx, navigate, cx)))
            }
            ModelRoute::Add => {
                Body::AddEdit(cx.new(|cx| AddEditPage::new(ctx, None, navigate, window, cx)))
            }
            ModelRoute::Edit(model_ref) => {
                let model_ref = Some(model_ref.clone());
                Body::AddEdit(cx.new(|cx| AddEditPage::new(ctx, model_ref, navigate, window, cx)))
            }
        };
        self.ctx
            .set_subpage(Some(title::subpage(route, self.navigate.clone())), cx);
        cx.notify();
    }
}

impl Render for ModelsPage {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let page = div();
        match &self.body {
            Body::Root => page.child(self.root.clone()),
            Body::ImageAdd(add) => page.child(add.clone()),
            Body::Management(management) | Body::ImageManagement(management) => {
                page.child(management.clone())
            }
            Body::AddEdit(add_edit) => page.child(add_edit.clone()),
        }
    }
}

pub(crate) fn page(ctx: SectionCtx, window: &mut Window, cx: &mut App) -> AnyView {
    cx.new(|cx| ModelsPage::new(ctx, window, cx)).into()
}
