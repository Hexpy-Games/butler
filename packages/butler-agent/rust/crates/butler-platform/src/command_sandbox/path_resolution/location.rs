//! Shell location state: POSIX cd uses a logical path, file operands use the
//! physical working directory. Neither survives uncertain execution.
use super::{PathCandidate, PathSyntax, lexical, words::Word};
use std::path::{Path, PathBuf};

type Position = (Option<PathBuf>, Option<PathBuf>);

pub(super) struct Directories {
    pub(super) current: Option<PathBuf>,
    logical: Option<PathBuf>,
    stack: Vec<Position>,
}
impl Directories {
    pub(super) fn new(cwd: &Path) -> Self {
        Self {
            current: Some(cwd.to_path_buf()),
            logical: Some(cwd.to_path_buf()),
            stack: Vec::new(),
        }
    }

    pub(super) fn invalidate(&mut self) {
        self.current = None;
        self.logical = None;
    }

    pub(super) fn change(
        &mut self,
        name: &str,
        tokens: &[Word],
        candidates: &[PathCandidate],
        home: Option<&str>,
        carries: bool,
        syntax: PathSyntax,
    ) -> bool {
        if ["popd", "pop-location"].contains(&name) {
            let position = (carries && tokens.len() == 1)
                .then(|| self.stack.pop())
                .flatten();
            (self.current, self.logical) = position.unwrap_or_default();
        } else if [
            "cd",
            "chdir",
            "pushd",
            "push-location",
            "set-location",
            "sl",
        ]
        .contains(&name)
        {
            let target = carries
                .then(|| self.target(tokens, candidates, home, syntax))
                .flatten();
            if ["pushd", "push-location"].contains(&name) && target.is_some() {
                self.stack
                    .push((self.current.clone(), self.logical.clone()));
            }
            (self.current, self.logical) = target.unwrap_or_default();
        } else {
            return false;
        }
        if !self.current.as_ref().is_some_and(|path| path.is_dir()) {
            self.invalidate();
        }
        true
    }

    fn target(
        &self,
        tokens: &[Word],
        candidates: &[PathCandidate],
        home: Option<&str>,
        syntax: PathSyntax,
    ) -> Option<Position> {
        let arguments: Vec<_> = tokens
            .iter()
            .enumerate()
            .skip(1)
            .filter(|(_, word)| syntax != PathSyntax::Cmd || !word.text.eq_ignore_ascii_case("/d"))
            .collect();
        let logical = match arguments.as_slice() {
            [] => PathBuf::from(home?),
            [(index, word)] if !word.text.is_empty() && !word.text.starts_with('-') => {
                let candidate = candidates.get(*index)?;
                if candidate.glob {
                    return None;
                }
                let physical = candidate.path.as_ref()?;
                if syntax != PathSyntax::Posix {
                    return Some((Some(physical.clone()), Some(physical.clone())));
                }
                let path = Path::new(&word.text);
                lexical(&if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    self.logical.as_ref()?.join(path)
                })
            }
            _ => return None,
        };
        let physical = crate::secure_fs::canonicalize(&logical).ok()?;
        Some((Some(physical), Some(logical)))
    }
}
