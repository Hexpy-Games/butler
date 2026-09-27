//! Production source boundaries between the domains of every workspace crate;
//! compiler checks still own complete name resolution.

mod policy;
mod references;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::modules;

type Edges = BTreeMap<String, BTreeSet<String>>;

pub(super) fn check(root: &Path) -> Result<bool, String> {
    let crates = workspace_crates(&root.join("crates"))?;
    if crates.is_empty() {
        return Ok(false);
    }
    let idents: BTreeSet<_> = crates.iter().map(|(ident, _)| ident.clone()).collect();
    let mut errors = BTreeSet::new();
    let (modules, owner) = load_crates(&crates, &mut errors)?;
    let domains: BTreeSet<_> = owner.keys().cloned().collect();
    for domain in &domains {
        if policy::dependencies(domain).is_none() {
            errors.insert(format!("domain {domain} has no reviewed dependency policy"));
        }
    }
    let graph = Graph {
        root,
        idents: &idents,
        domains: &domains,
        owner: &owner,
        children: modules
            .iter()
            .filter(|module| module.path.len() == 2)
            .map(|module| module.path.clone())
            .collect(),
    };
    let edges = graph.edges(&modules, &mut errors);
    for source in &domains {
        let mut path = vec![source.clone()];
        let mut visited = BTreeSet::new();
        if cycle(source, source, &edges, &mut path, &mut visited) {
            errors.insert(format!("domain dependency cycle: {}", path.join(" -> ")));
        }
    }
    report(&modules, &domains, &edges, &errors);
    Ok(!errors.is_empty())
}

/// Every module of every crate, and the crate that owns each top-level domain.
fn load_crates(
    crates: &[(String, PathBuf)],
    errors: &mut BTreeSet<String>,
) -> Result<(Vec<modules::Module>, BTreeMap<String, String>), String> {
    let mut modules = Vec::new();
    let mut owner = BTreeMap::<String, String>::new();
    for (ident, entry) in crates {
        for module in modules::load(entry)? {
            if let Some(domain) = module.path.first()
                && let Some(other) = owner.insert(domain.clone(), ident.clone())
                && other != *ident
            {
                errors.insert(format!(
                    "domain {domain} is declared by {other} and {ident}"
                ));
            }
            modules.push(module);
        }
    }
    Ok((modules, owner))
}

/// What the domain edges are checked against.
struct Graph<'a> {
    root: &'a Path,
    idents: &'a BTreeSet<String>,
    domains: &'a BTreeSet<String>,
    owner: &'a BTreeMap<String, String>,
    children: BTreeSet<Vec<String>>,
}

impl Graph<'_> {
    /// The domain edges every module's references imply, recording reference
    /// errors and edges the policy does not allow.
    fn edges(&self, modules: &[modules::Module], errors: &mut BTreeSet<String>) -> Edges {
        let mut edges = Edges::new();
        for module in modules {
            let references = references::References::collect(module, self.idents);
            let file = module
                .file
                .strip_prefix(self.root)
                .unwrap_or(&module.file)
                .display()
                .to_string();
            for error in references.errors {
                errors.insert(format!("{file}: {error}"));
            }
            let Some(source) = module.path.first() else {
                continue;
            };
            for path in references.paths {
                self.edge(&file, source, &path, &mut edges, errors);
            }
        }
        edges
    }

    fn edge(
        &self,
        file: &str,
        source: &String,
        path: &[String],
        edges: &mut Edges,
        errors: &mut BTreeSet<String>,
    ) {
        let Some(target) = path.first() else {
            return;
        };
        if source == target || !self.domains.contains(target) {
            return;
        }
        edges
            .entry(source.clone())
            .or_default()
            .insert(target.clone());
        // Edges between crates are declared, and enforced, by Cargo; the
        // policy reviews the directions between domains of one crate.
        let same_crate = self.owner.get(source) == self.owner.get(target);
        if same_crate
            && !policy::dependencies(source)
                .is_some_and(|allowed| allowed.contains(&target.as_str()))
        {
            errors.insert(format!(
                "{file}: dependency {source} -> {target} is not allowed"
            ));
        }
        if let Some(child) = path.get(..2)
            && self.children.contains(child)
        {
            errors.insert(format!(
                "{file}: cross-domain child access {}; use the {target} facade",
                path.join("::")
            ));
        }
    }
}

fn report(
    modules: &[modules::Module],
    domains: &BTreeSet<String>,
    edges: &Edges,
    errors: &BTreeSet<String>,
) {
    for (source, targets) in edges {
        println!(
            "DEPENDENCY {source} -> {}",
            targets.iter().cloned().collect::<Vec<_>>().join(", ")
        );
    }
    for error in errors {
        eprintln!("ARCHITECTURE ERROR {error}");
    }
    println!(
        "ARCHITECTURE modules={} domains={} violations={}",
        modules.len(),
        domains.len(),
        errors.len()
    );
}

/// Every `crates/<name>/src/lib.rs`, keyed by the crate's Rust identifier.
fn workspace_crates(directory: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut crates = Vec::new();
    let entries =
        fs::read_dir(directory).map_err(|error| format!("{}: {error}", directory.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("{}: {error}", directory.display()))?;
        let entry_file = entry.path().join("src").join("lib.rs");
        if entry_file.is_file() {
            let ident = entry.file_name().to_string_lossy().replace('-', "_");
            crates.push((ident, entry_file));
        }
    }
    crates.sort();
    Ok(crates)
}

fn cycle(
    origin: &str,
    current: &str,
    edges: &Edges,
    path: &mut Vec<String>,
    visited: &mut BTreeSet<String>,
) -> bool {
    if !visited.insert(current.to_owned()) {
        return false;
    }
    if let Some(targets) = edges.get(current) {
        for target in targets {
            path.push(target.clone());
            if target == origin || cycle(origin, target, edges, path, visited) {
                return true;
            }
            path.pop();
        }
    }
    false
}
