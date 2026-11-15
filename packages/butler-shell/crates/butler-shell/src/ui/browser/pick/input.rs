use super::probe;
use crate::ui::browser::{engine::TabId,model::BrowserState};
use gpui::App;
#[derive(Clone)]
pub(super) struct Press;
pub(crate) fn hover(id: &TabId, x: f64, y: f64, cx: &mut App) {
    let Some(session) = cx.global::<BrowserState>().tab(id).map(|t| t.pick.clone()) else {
        return;
    };
    session.point.set(Some((x, y)));
    session.revision.set(session.revision.get() + 1);
    if session.pending.replace(true) {
        return;
    }
    let id = id.clone();
    cx.spawn(async move |cx| {
        loop {
            let revision = session.revision.get();
            let generation = session.generation.get();
            let Some((x, y)) = session.point.get() else {
                break;
            };
            let preferred = session.preferred.borrow().clone();
            let mut result = probe::probe(&id, x, y, preferred.as_deref(), cx).await;
            if revision != session.revision.get() {
                continue;
            }
            cx.update(|cx| {
                if let Some(tab) = cx.global_mut::<BrowserState>().tabs.iter_mut().find(|t| {
                    t.id == id
                        && t.picking
                        && t.pick.generation.get() == generation
                        && t.pick.down.borrow().is_none()
                }) {
                    if let Ok(hover) = result.as_mut() {
                        let preferred = tab.pick.preferred.borrow().clone();
                        if let Some(preferred) = preferred {
                            if let Some(index) = hover
                                .levels
                                .iter()
                                .position(|l| l.data["identity"] == preferred)
                            {
                                hover.index = index;
                                probe::label(hover);
                            } else {
                                tab.pick.preferred.borrow_mut().take();
                            }
                        }
                    }
                    tab.pick_hover = result.ok().filter(|h| !h.levels.is_empty());
                }
                cx.refresh_windows();
            });
            break;
        }
        session.pending.set(false);
    })
    .detach();
}
