//! Programs whose documented operations create or restore filesystem links.
use super::{PathCandidate, resolve, words::Word};
use std::path::Path;

pub(super) fn creates(tokens: &[Word]) -> bool {
    let Some(program) = tokens.first() else {
        return false;
    };
    // A path identifies arbitrary repository/user code, never a builtin by basename.
    if program.text.contains(['/', '\\']) {
        return true;
    }
    let name = program.text.to_ascii_lowercase();
    let name = name.trim_end_matches(".exe");
    match name {
        // Interpreters remain opaque in the caller, including redirected input.
        "ln" | "link" | "rsync" | "tar" | "bsdtar" | "unzip" | "7z" | "cpio" | "pax" | "mklink"
        | "sh" | "bash" | "zsh" | "python" | "python3" | "node" | "perl" | "ruby" | "pwsh"
        | "powershell" | "cmd" => true,
        "cp" => copy_links(tokens),
        "git" => git_operation(tokens).is_some_and(|operation| {
            [
                "checkout",
                "clone",
                "apply",
                "stash",
                "reset",
                "worktree",
                "submodule",
            ]
            .contains(&operation)
        }),
        "fsutil" => tokens
            .get(1)
            .is_some_and(|word| word.text.eq_ignore_ascii_case("hardlink")),
        "new-item" | "ni" => tokens.windows(2).any(|pair| {
            matches!(pair, [option, kind] if option.text.eq_ignore_ascii_case("-ItemType")
                && ["symboliclink", "junction", "hardlink"]
                    .contains(&kind.text.to_ascii_lowercase().as_str()))
        }),
        _ => false,
    }
}

fn copy_links(tokens: &[Word]) -> bool {
    tokens
        .iter()
        .skip(1)
        .take_while(|word| word.text != "--")
        .any(|word| {
            let flag = word.text.as_str();
            flag.starts_with('-')
                && !flag.starts_with("--")
                && flag[1..].contains(['s', 'l', 'a', 'R', 'r', 'P', 'd'])
                || [
                    "--symbolic-link",
                    "--link",
                    "--archive",
                    "--recursive",
                    "--no-dereference",
                ]
                .contains(&flag)
                || flag.strip_prefix("--preserve=").is_some_and(|value| {
                    value
                        .split(',')
                        .any(|part| ["links", "all"].contains(&part))
                })
        })
}

fn git_operation(tokens: &[Word]) -> Option<&str> {
    let mut arguments = tokens.iter().skip(1);
    while let Some(word) = arguments.next() {
        if [
            "-C",
            "-c",
            "--git-dir",
            "--work-tree",
            "--namespace",
            "--config-env",
        ]
        .contains(&word.text.as_str())
        {
            arguments.next()?;
        } else if !word.text.starts_with('-') {
            return Some(&word.text);
        }
    }
    None
}

/// Symbolic ln operands name their targets relative to the new link's folder,
/// not the shell cwd. Unknown option/operand layouts must remain incomplete.
pub(super) fn targets(tokens: &[Word], candidates: &mut [PathCandidate]) {
    if tokens.first().is_none_or(|word| word.text != "ln") {
        return;
    }
    let symbolic = tokens
        .iter()
        .skip(1)
        .take_while(|word| word.text != "--")
        .any(|word| {
            word.text == "--symbolic"
                || word.text.starts_with('-')
                    && !word.text.starts_with("--")
                    && word.text[1..].contains('s')
        });
    if !symbolic {
        return;
    }
    let Some((sources, directory, no_directory)) = operands(tokens) else {
        for candidate in candidates.iter_mut().skip(1) {
            candidate.path = None;
        }
        return;
    };
    let Some((&destination, sources)) = sources.split_last() else {
        return;
    };
    let (destination, sources) = if let Some(directory) = directory {
        (
            directory,
            sources
                .iter()
                .copied()
                .chain([destination])
                .collect::<Vec<_>>(),
        )
    } else {
        (destination, sources.to_vec())
    };
    let folder = candidates
        .get(destination)
        .and_then(|candidate| candidate.path.as_deref())
        .and_then(|path| {
            if directory.is_some() || !no_directory && path.is_dir() {
                Some(path)
            } else {
                path.parent()
            }
        })
        .map(Path::to_path_buf);
    for index in sources {
        if let Some(candidate) = candidates.get_mut(index) {
            candidate.path = tokens
                .get(index)
                .and_then(|word| resolve(&word.text, folder.as_deref(), false));
        }
    }
}

fn operands(tokens: &[Word]) -> Option<(Vec<usize>, Option<usize>, bool)> {
    let mut operands = Vec::new();
    let mut directory = None;
    let mut no_directory = false;
    let mut options = true;
    let mut words = tokens.iter().enumerate().skip(1);
    while let Some((index, word)) = words.next() {
        let text = word.text.as_str();
        if options && text == "--" {
            options = false;
        } else if options && ["-t", "--target-directory"].contains(&text) {
            directory = Some(words.next()?.0);
        } else if options && text.starts_with('-') {
            if [
                "--symbolic",
                "--force",
                "--interactive",
                "--no-dereference",
                "--verbose",
                "--no-target-directory",
            ]
            .contains(&text)
            {
                no_directory |= text == "--no-target-directory";
            } else if !text.starts_with("--")
                && text[1..].chars().all(|ch| "sfivnTPLh".contains(ch))
            {
                no_directory |= text.contains('T');
            } else {
                return None;
            }
        } else {
            operands.push(index);
        }
    }
    Some((operands, directory, no_directory))
}
