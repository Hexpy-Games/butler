//! Programs whose documented operations create or restore filesystem links.
use super::{PathCandidate, resolve, words::Word};
use std::path::Path;

/// Whether this segment can create a filesystem link. The category is explicit:
/// ordinary programs, including bare build tools, are not link creators.
pub(super) fn creates(tokens: &[Word]) -> bool {
    let Some(program) = tokens.first() else {
        return false;
    };
    // A path identifies repository or user code, never a known program.
    if program.text.contains(['/', '\\']) {
        return true;
    }
    let name = program.text.to_ascii_lowercase();
    let name = name.trim_end_matches(".exe");
    let arguments = tokens.get(1..).unwrap_or_default();
    match name {
        "ln" | "link" | "rsync" | "tar" | "bsdtar" | "unzip" | "7z" | "cpio" | "pax" | "mklink" => {
            true
        }
        "cp" => copy_links(tokens),
        "git" => git_operation(tokens).is_some_and(|operation| GIT_WORKTREE.contains(&operation)),
        "fsutil" => arguments
            .first()
            .is_some_and(|word| word.text.eq_ignore_ascii_case("hardlink")),
        // Parameter names may be abbreviated (-Type) or joined (-ItemType:Junction).
        "new-item" | "ni" => arguments.iter().any(|word| {
            let value = word.text.to_ascii_lowercase();
            let value = value.rsplit(':').next().unwrap_or_default();
            ["symboliclink", "junction", "hardlink"].contains(&value)
        }),
        // Programs that run a command given in their own arguments.
        "xargs" => (1..tokens.len()).any(|index| tokens.get(index..).is_some_and(creates)),
        "find" => tokens.iter().enumerate().any(|(index, word)| {
            ["-exec", "-execdir", "-ok", "-okdir"].contains(&word.text.as_str())
                && tokens.get(index + 1..).is_some_and(creates)
        }),
        _ => inline_code(name, arguments),
    }
}

const GIT_WORKTREE: [&str; 13] = [
    "checkout",
    "switch",
    "clone",
    "apply",
    "stash",
    "reset",
    "restore",
    "worktree",
    "submodule",
    "pull",
    "merge",
    "rebase",
    "cherry-pick",
];

/// Interpreters running code from the command line. Scripts and inline code
/// stay opaque in the caller; inline code also counts as a link creator.
fn inline_code(name: &str, arguments: &[Word]) -> bool {
    let short = |flags: &[char]| {
        arguments.iter().any(|word| {
            word.text.starts_with('-')
                && !word.text.starts_with("--")
                && word.text[1..].contains(flags)
        })
    };
    match name {
        "sh" | "bash" | "zsh" | "dash" | "ksh" | "python" | "python3" => short(&['c']),
        "perl" => short(&['e', 'E']),
        "ruby" => short(&['e']),
        "node" => {
            short(&['e', 'p'])
                || arguments
                    .iter()
                    .any(|word| ["--eval", "--print"].contains(&word.text.as_str()))
        }
        "pwsh" | "powershell" => arguments.iter().any(|word| {
            let option = word.text.to_ascii_lowercase();
            option.strip_prefix(['-', '/']).is_some_and(|option| {
                !option.is_empty()
                    && ("command".starts_with(option)
                        || "encodedcommand".starts_with(option)
                        || option == "ec")
            })
        }),
        "cmd" => arguments.iter().any(|word| {
            let option = word.text.to_ascii_lowercase();
            ["/c", "/k", "/r"]
                .iter()
                .any(|flag| option.starts_with(flag))
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
