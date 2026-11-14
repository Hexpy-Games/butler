//! Canon parts the board, the aside and the plan overview share (`canon/CanonStatusGlyph.tsx`,
//! `CanonEpicStatus.tsx`, `CriteriaProgress.tsx`, `CanonAvatar.tsx`, `useCanonPersonName.ts`,
//! `localPerson.ts`, `canonActorLabel.ts`, `CanonTagList.tsx`, `CanonTagsField.tsx`,
//! `CanonTagChooser.tsx`, `CanonTagManageDialog.tsx`, `useCanonTags.ts`, `CanonPlanSelect.tsx`,
//! `CanonPersonSelect.tsx`, `CanonFormFields.tsx`, `CanonFormFooter.tsx`).
use std::rc::Rc;

use gpui::{App, SharedString, Window};

use crate::ui::manage::Pick;
use crate::ui::source::wire::CanonTag;

mod chooser;
mod copy;
mod editor;
mod field;
mod form;
mod manage;
mod people;
pub(crate) mod status;
mod tags;

pub(crate) use chooser::TagChooser;
pub(crate) use field::TagsField;
pub(crate) use form::{form_fields, form_footer_submit, plan_select};
pub(crate) use people::{actor_label, canon_avatar, person_name, person_select, warm_person_name};
pub(crate) use status::{criteria_progress, epic_activity, epic_status};
pub(crate) use tags::{CanonTags, tag_list};

/// `LOCAL_PERSON_ID` (localPerson.ts)
pub(crate) const LOCAL_PERSON_ID: &str = "app-user";

/// The remove callback of a tag in [`tag_list`].
pub(crate) type RemoveTag = Rc<dyn Fn(&SharedString, &mut Window, &mut App)>;

/// The shared props of [`plan_select`] and [`person_select`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct SelectOpts {
    pub(crate) disabled: bool,
    pub(crate) compact: bool,
    pub(crate) stretch: bool,
}

/// A select's change callback (`None`: no plan, or no person).
pub(crate) type OnSelect = Pick<Option<SharedString>>;

/// What [`CanonTags::create`] answers.
pub(crate) type TagCreated = Box<dyn FnOnce(Option<CanonTag>, &mut App)>;

/// A tag field's change callback.
pub(crate) type OnTags = Pick<Vec<SharedString>>;
