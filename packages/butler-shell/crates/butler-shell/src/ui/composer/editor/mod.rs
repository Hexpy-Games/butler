// Skeleton (Opus, P2 shell wave): the unit that owns this file fills it; see
// /Users/home-dev/p14-jobs/gpui-port-orch/specs/p2-shell-wave.md for the contract.
//! `ComposerTextArea`, `ComposerEditorPlugin`, `composition.ts`, `draftSync.ts`, `composerFocus.ts`
//! on gpui-ce EditableText.
pub(crate) mod atoms;
pub(crate) mod clipboard;
pub(crate) mod drop;
pub(crate) mod mentions;
pub(crate) mod serialize;

use gpui::SharedString;

/// An inline atom (Lexical decorator node).
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Atom {
    /// `ProjectReferenceNode`.
    Project { id: String, label: SharedString },
    /// `SessionReferenceNode` (a dropped sidebar session).
    Session { id: String, label: SharedString },
    /// `ProjectSourceNode`.
    ProjectSource { id: String, label: SharedString },
}

/// The editor content in order (`serialization.ts`).
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ComposerPart {
    Text(String),
    Atom(Atom),
}

/// The composer's rich-text editor: EditableText plus atom ranges.
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
#[derive(Default)]
pub(crate) struct ComposerEditor {
    parts: Vec<ComposerPart>,
}

#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
impl ComposerEditor {
    pub(crate) fn parts(&self) -> &[ComposerPart] {
        &self.parts
    }

    pub(crate) fn insert_atom(&mut self, atom: Atom) {
        self.parts.push(ComposerPart::Atom(atom));
    }

    pub(crate) fn clear(&mut self) {
        self.parts.clear();
    }
}
