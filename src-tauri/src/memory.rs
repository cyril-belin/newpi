//! The memory feature's application side: where its files live, which project
//! they belong to, and how the harness is told about both.
//!
//! Three facts have to line up before the harness can store a memory:
//!
//! 1. the sidecar is reachable on a loopback port that is only known at launch;
//! 2. the project scope is fixed, so no tool call can name another project;
//! 3. the harness can import the plugins and read the migration.
//!
//! This module owns all three. It is deliberately free of process management:
//! [`crate::pocketbase`] starts and stops the sidecar, and this module only
//! describes the layout they share, which makes the layout testable without
//! spawning anything.
//!
//! # The project scope
//!
//! A project's memory scope comes from the project's own `cordis.yml`, at
//! `<workspace>/.newpi/cordis.yml`:
//!
//! ```yaml
//! memory:
//!   project_id: twin
//! ```
//!
//! The file is optional. A workspace without one gets a stable identifier
//! derived from its directory name, so memory works out of the box and the
//! identifier can still be pinned later without losing what was already
//! recorded under the derived name. NewPi only ever *reads* this file: it is
//! the user's document, and a generated default is reported rather than
//! written into it.
//!
//! The value is passed to the harness as plugin configuration and as an
//! environment variable. It is never a tool argument — the three tools expose
//! `content`, `kind`, `query`, `limit` and `id`, and nothing else.

use std::path::{Path, PathBuf};

use crate::assets::PLUGINS;
use crate::patch::{self, Row};

/// Environment variable carrying the sidecar's loopback base URL.
pub const ENV_URL: &str = "DSH_MEMORY_URL";
/// Environment variable carrying the superuser identity.
pub const ENV_IDENTITY: &str = "DSH_MEMORY_IDENTITY";
/// Environment variable carrying the superuser password.
pub const ENV_PASSWORD: &str = "DSH_MEMORY_PASSWORD";
/// Environment variable carrying the project scope.
pub const ENV_PROJECT_ID: &str = "DSH_MEMORY_PROJECT_ID";
/// Environment variable that turns the whole feature off for one launch.
pub const ENV_ENABLED: &str = "NEWPI_MEMORY";

/// The row id Mem0 would occupy in a profile composition. NewPi disables it by
/// id rather than by package name so the row is matched however the user
/// installed it.
const MEM0_ROW_ID: &str = "mem0";

/// Relative path of the project's own configuration file, inside the workspace.
///
/// It is also where the model router reads its plan, so the path is shared
/// rather than written twice: the two features read the same document.
pub(crate) const PROJECT_CONFIG: &str = ".newpi/cordis.yml";

/// Every path the memory feature owns, all of them below the application's
/// state directory.
#[derive(Debug, Clone)]
pub struct Layout {
    /// The application's state directory itself
    /// (`~/Library/Application Support/NewPi`). Kept as its own field because
    /// the storage console reports it and must not have to re-derive it from a
    /// child path.
    pub state: PathBuf,
    /// `<state>/pocketbase` — the extracted sidecar executable.
    pub pocketbase: PathBuf,
    /// `<state>/pocketbase/pb_data` — the database. Never inside the bundle.
    pub data: PathBuf,
    /// `<state>/pocketbase/pb_migrations` — the applied migration.
    pub migrations: PathBuf,
    /// `<state>/pocketbase/credentials` — the generated superuser credential.
    pub credentials: PathBuf,
    /// `<state>/pocketbase/version` — the extracted binary's version marker.
    pub version: PathBuf,
    /// `<state>/backups` — the archives NewPi makes for the user. Deliberately
    /// outside `pb_data`: PocketBase owns its own backup directory and prunes
    /// it, and a backup the user asked for is not the sidecar's to remove.
    pub backups: PathBuf,
    /// `<state>/plugins` — the deployed Cordis plugins.
    pub plugins: PathBuf,
    /// `<state>/launcher.patch.yml` — the harness overlay for this launch.
    pub launcher_patch: PathBuf,
}

impl Layout {
    /// Resolve every path below one state directory.
    ///
    /// @param state - the application's state directory, e.g.
    ///   `~/Library/Application Support/NewPi`.
    /// @returns the layout. Nothing is created here.
    pub fn new(state: &Path) -> Self {
        let pocketbase = state.join("pocketbase");
        Self {
            state: state.to_path_buf(),
            pocketbase: pocketbase.join("pocketbase"),
            data: pocketbase.join("pb_data"),
            migrations: pocketbase.join("pb_migrations"),
            credentials: pocketbase.join("credentials"),
            version: pocketbase.join("version"),
            backups: state.join("backups"),
            plugins: state.join("plugins"),
            launcher_patch: state.join(patch::LAUNCHER_PATCH_FILENAME),
        }
    }

    /// Create every directory the feature writes into.
    ///
    /// @throws a message naming the directory when creation fails.
    pub fn create(&self) -> Result<(), String> {
        for directory in [
            self.data.clone(),
            self.migrations.clone(),
            self.backups.clone(),
            self.plugins.clone(),
        ] {
            std::fs::create_dir_all(&directory).map_err(|error| {
                format!("Création impossible de {} : {error}", directory.display())
            })?;
        }
        Ok(())
    }

    /// The directory the sidecar keeps its own snapshots in.
    ///
    /// @returns `<pb_data>/backups`, which PocketBase creates on its first
    /// snapshot and which the console reads rather than guessing at.
    pub fn snapshots(&self) -> PathBuf {
        self.data.join("backups")
    }
}

/// Write one embedded file, but only when its content differs.
///
/// Rewriting an identical module would change its modification time, and the
/// harness watches profile files; keeping the write conditional means a launch
/// with unchanged plugins touches nothing on disk.
///
/// The name may carry a relative path (`nested/thing.js`): the plugin's files
/// are deployed under the plugin's own directory, and the directory a nested
/// name lives in is created here rather than by every caller.
///
/// @param directory - the plugin's directory.
/// @param name - the file's path, relative to that directory.
/// @param content - the desired content.
/// @returns whether the file was (re)written.
/// @throws a message naming the path when the write fails.
fn materialize(directory: &Path, name: &str, content: &str) -> Result<bool, String> {
    let path = directory.join(name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Création impossible de {} : {error}", parent.display()))?;
    }
    if let Ok(existing) = std::fs::read_to_string(&path) {
        if existing == content {
            return Ok(false);
        }
    }
    std::fs::write(&path, content)
        .map_err(|error| format!("Écriture impossible de {} : {error}", path.display()))?;
    Ok(true)
}

/// Remove every file below `directory` that is not one of `expected`.
///
/// The comparison is on the path relative to the plugin's directory, so a
/// nested file and a top level one with the same base name are distinct. Empty
/// directories left behind are removed too: a plugin whose last nested file
/// disappeared should not keep the directory that held it.
///
/// @param directory - the plugin's directory.
/// @param relative - where the walk currently is, relative to it.
/// @param expected - the relative names that must survive.
/// @param removed - how many files have been removed, for the report.
/// @throws a message naming the path when a removal fails.
fn prune(
    directory: &Path,
    relative: &Path,
    expected: &[&str],
    removed: &mut usize,
) -> Result<(), String> {
    let here = directory.join(relative);
    let entries = std::fs::read_dir(&here)
        .map_err(|error| format!("Lecture impossible de {} : {error}", here.display()))?;

    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let child = relative.join(name);
        let Some(child_text) = child.to_str() else {
            continue;
        };

        if entry.path().is_dir() {
            prune(directory, &child, expected, removed)?;
            // A directory the walk left empty is one whose contents are all
            // stale; it has no reason to stay.
            if std::fs::read_dir(&here)
                .map(|mut rest| rest.next().is_none())
                .unwrap_or(false)
            {
                let _ = std::fs::remove_dir(&here);
            }
            continue;
        }

        if !expected.contains(&child_text) {
            std::fs::remove_file(entry.path()).map_err(|error| {
                format!(
                    "Suppression impossible de {} : {error}",
                    entry.path().display()
                )
            })?;
            *removed += 1;
        }
    }

    Ok(())
}

/// Deploy the embedded plugins and the migration into the layout.
///
/// The plugin directories are pruned to exactly the embedded set, so a module
/// removed from the application cannot linger and keep being imported, and a
/// plugin removed altogether cannot linger either.
///
/// That second half is not symmetry for its own sake. A plugin directory left
/// on disk after the application stopped shipping it is a directory the
/// launcher patch no longer mounts, and the acceptance check reads the two sets
/// against each other — a stale directory makes a healthy launch look broken.
/// It is also the only thing that ever deletes a plugin's files from a machine
/// that has already run an older build.
///
/// @param layout - the resolved layout; its directories must exist.
/// @param dev - the development plugin source, when `dev.json` names one: the
/// plugins it provides are left alone, because the repository owns them.
/// @returns the number of files written and removed, for the launch report.
/// @throws a message naming the path when a write or prune fails.
pub fn deploy_assets(
    layout: &Layout,
    dev: Option<&crate::dev::DevSource>,
) -> Result<(usize, usize), String> {
    let mut written = 0;
    let mut removed = 0;

    for (plugin, files) in PLUGINS {
        // A plugin the development source provides is not deployed at all: no
        // write, and no prune either — pruning it would delete the repository's
        // own files the moment a developer added one the manifest does not list.
        if dev.is_some_and(|source| source.entry(plugin).is_some()) {
            continue;
        }
        let directory = layout.plugins.join(plugin);
        std::fs::create_dir_all(&directory)
            .map_err(|error| format!("Création impossible de {} : {error}", directory.display()))?;

        let mut expected: Vec<&str> = Vec::with_capacity(files.len());
        for (name, source) in *files {
            expected.push(name);
            if materialize(&directory, name, source)? {
                written += 1;
            }
        }

        prune(&directory, Path::new(""), &expected, &mut removed)?;
    }

    removed += prune_plugins(layout, dev)?;

    let (name, source) = crate::assets::MIGRATION;
    if materialize(&layout.migrations, name, source)? {
        written += 1;
    }

    Ok((written, removed))
}

/// Remove the plugin directories the application no longer ships.
///
/// Only directories are considered, and only direct children: the module tree
/// lives at `plugins/node_modules` as a symlink the deploy does not own, and a
/// file sitting directly in `plugins/` is not something this application ever
/// wrote. Anything else whose name is not in [`PLUGINS`] is a directory from a
/// build that is gone.
///
/// @param layout - the resolved layout; its plugin directory must exist.
/// @param dev - the development plugin source, when one is configured: a
/// directory it provides is not this application's to delete.
/// @returns how many directories were removed.
/// @throws a message naming the path when a removal fails.
fn prune_plugins(layout: &Layout, dev: Option<&crate::dev::DevSource>) -> Result<usize, String> {
    let root = &layout.plugins;
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        // No plugins directory yet: the first pass over `PLUGINS` created it,
        // so this only happens when the whole state directory is missing, and
        // there is then nothing to prune.
        Err(_) => return Ok(0),
    };

    let mut removed = 0;
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name == "node_modules"
            || PLUGINS.iter().any(|(plugin, _)| *plugin == name)
            || dev.is_some_and(|source| source.entry(name).is_some())
        {
            continue;
        }
        std::fs::remove_dir_all(entry.path()).map_err(|error| {
            format!(
                "Suppression impossible de {} : {error}",
                entry.path().display()
            )
        })?;
        removed += 1;
    }
    Ok(removed)
}

/// Link the harness's module tree next to the deployed plugins.
///
/// The plugins import `@deepseek-ai/cordis` and `@deepseek-ai/schemastery`.
/// Those are bare specifiers, so Node resolves them by walking up from the
/// plugin file's real location — which is the application's state directory,
/// nowhere near the harness installation. Without a module tree to walk up to,
/// the harness fails to import a plugin with `Cannot find package
/// '@deepseek-ai/cordis'` and the whole profile refuses to load.
///
/// A single symlink fixes it for every package the harness ships, and keeps
/// fixing it: the harness's own `healProfilesModuleFallback` maintains
/// `$DSH_HOME/profiles/node_modules`, so following that link always resolves to
/// the versions the running harness actually loaded. The fallback path covers a
/// profile that has not been booted yet.
///
/// @param layout - the resolved layout; its plugin directory must exist.
/// @param dsh_home - the harness home (`$DSH_HOME`).
/// @returns the tree that was linked, for the launch log, or `None` when no
/// candidate exists — which is reported rather than silently accepted, because
/// the plugins cannot load without one.
pub fn link_module_tree(layout: &Layout, dsh_home: &Path) -> Option<PathBuf> {
    let link = layout.plugins.join("node_modules");
    if link.exists() {
        return Some(std::fs::read_link(&link).unwrap_or(link));
    }

    let candidates = [dsh_home.join("profiles").join("node_modules")];
    let source = candidates
        .iter()
        .find(|candidate| candidate.is_dir())?
        .clone();

    std::os::unix::fs::symlink(&source, &link).ok()?;
    Some(source)
}

/// The project's memory scope, its human name, and where it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
    /// The Project Model's stable identifier for this project.
    pub id: String,
    /// The human name the interface shows for it.
    pub name: String,
    /// The namespace every memory of this project is stored under.
    pub namespace: String,
    /// The project's root directory, which the harness also runs in.
    pub root: PathBuf,
    /// The file the namespace was pinned in, when it did not come from the
    /// workspace's name or from the Project Model's registry.
    pub source: Option<PathBuf>,
}

impl Project {
    /// Resolve the scope for one explicitly named workspace.
    ///
    /// This is the compatibility path — `NEWPI_WORKSPACE` — where no Project
    /// Model record exists yet. The id is kept equal to the namespace so a
    /// pinned `memory.project_id` still opens the same project it always did.
    ///
    /// @param workspace - the workspace root handed to the harness.
    /// @returns the scope, pinned by the project's `cordis.yml` when it names
    /// one, and derived from the directory name otherwise.
    /// @throws when the configuration file exists but cannot be read.
    pub fn resolve(workspace: &Path) -> Result<Self, String> {
        let config = workspace.join(PROJECT_CONFIG);
        let pinned = if config.is_file() {
            let text = std::fs::read_to_string(&config)
                .map_err(|error| format!("Lecture impossible de {} : {error}", config.display()))?;
            // A file that exists but names no project is not an error: the
            // workspace is simply on the derived default. Saying so out loud
            // in the launch log is what keeps that from being a mystery.
            project_id_in(&text)
        } else {
            None
        };
        let namespace = pinned
            .clone()
            .unwrap_or_else(|| derived_id(workspace));
        Ok(Self {
            id: namespace.clone(),
            name: display_name(workspace),
            namespace,
            root: workspace.to_path_buf(),
            source: pinned.map(|_| config),
        })
    }
}

/// The human name of a workspace, as its directory spells it.
///
/// @param workspace - the workspace root.
/// @returns the directory's own name, or an empty string for a root with none.
pub fn display_name(workspace: &Path) -> String {
    workspace
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Read `memory.project_id` out of the project configuration.
///
/// The parser is deliberately small: two levels of indentation, an optional
/// document marker, `#` comments, and quoted or bare scalars. It reads exactly
/// one key of one file, and anything it does not understand it ignores rather
/// than misinterpret — a wrong identifier is worse than no identifier, because
/// it silently splits a project's memory in two.
///
/// @param text - the file's contents.
/// @returns the identifier, or `None` when the file does not name one.
pub fn project_id_in(text: &str) -> Option<String> {
    let mut in_memory_block = false;

    for raw in text.lines() {
        let line = strip_comment(raw);
        if line.trim().is_empty() || line.trim_start().starts_with("---") {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        let trimmed = line.trim();

        if indent == 0 {
            // A new top level key ends any block we were in.
            in_memory_block = matches!(top_level_key(trimmed), Some("memory"));
            continue;
        }
        if !in_memory_block {
            continue;
        }
        if indent > 2 {
            // A nested key below `memory:` — not ours. `project_id` is a direct
            // child, so a deeper `project_id` belongs to something else.
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("project_id:") {
            let value = unquote(value.trim());
            if !value.is_empty() {
                return Some(value);
            }
        }
    }

    None
}

/// The key of a top level `key:` line, if the line is one.
fn top_level_key(trimmed: &str) -> Option<&str> {
    let (key, rest) = trimmed.split_once(':')?;
    if key.is_empty() || key.contains(char::is_whitespace) {
        return None;
    }
    // `memory: value` is not a block header.
    if !rest.trim().is_empty() {
        return None;
    }
    Some(key)
}

/// Remove a trailing `#` comment, respecting quotes.
pub(crate) fn strip_comment(line: &str) -> String {
    let mut result = String::with_capacity(line.len());
    let mut quote: Option<char> = None;
    for character in line.chars() {
        match quote {
            Some(active) if character == active => {
                quote = None;
                result.push(character);
            }
            Some(_) => result.push(character),
            None if character == '\'' || character == '"' => {
                quote = Some(character);
                result.push(character);
            }
            None if character == '#' => break,
            None => result.push(character),
        }
    }
    result
}

/// Remove matching surrounding quotes from a scalar.
pub(crate) fn unquote(value: &str) -> String {
    let trimmed = value.trim();
    for quote in ['\'', '"'] {
        if trimmed.len() >= 2 && trimmed.starts_with(quote) && trimmed.ends_with(quote) {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

/// Derive a stable identifier from a workspace path.
///
/// The directory name is reduced to the characters a PocketBase filter literal
/// and a log line can both carry without escaping, so the derived value stays
/// readable and predictable. Two different workspaces with the same base name
/// would collide; pinning `memory.project_id` in the project's `cordis.yml` is
/// the documented answer, and the launch log names the file to edit.
///
/// @param workspace - the workspace root.
/// @returns the identifier.
pub fn derived_id(workspace: &Path) -> String {
    let base = workspace
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut slug = String::with_capacity(base.len());
    let mut last_was_separator = false;
    for character in base.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
            last_was_separator = false;
        } else if !last_was_separator && !slug.is_empty() {
            slug.push('-');
            last_was_separator = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        "default".to_string()
    } else {
        slug
    }
}

/// Whether the feature is enabled for this launch.
///
/// @returns `true` unless `NEWPI_MEMORY` is set to `0`, `false`, `no` or `off`.
pub fn enabled() -> bool {
    match std::env::var(ENV_ENABLED) {
        Ok(value) => !matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        ),
        Err(_) => true,
    }
}

/// The roots the storage console measures and is fenced by, resolved once.
///
/// They are passed to the plugin as configuration, so the browser never names a
/// directory: the only paths the Storage section can look at, and the only ones
/// a cleanup can be pointed at, are the ones NewPi resolved before the harness
/// started.
#[derive(Debug, Clone)]
pub struct Roots {
    /// The user's home directory.
    pub home: PathBuf,
    /// The project directory the harness runs in.
    pub workspace: PathBuf,
    /// The harness home (`$DSH_HOME`, normally `~/.dsh`).
    pub dsh_home: PathBuf,
}

impl Roots {
    /// Bundle the three roots the runtime already resolved.
    ///
    /// @param workspace - the workspace root.
    /// @param home - the home directory.
    /// @param dsh_home - the harness home.
    /// @returns the roots.
    pub fn new(workspace: &Path, home: &Path, dsh_home: &Path) -> Self {
        Self {
            home: home.to_path_buf(),
            workspace: workspace.to_path_buf(),
            dsh_home: dsh_home.to_path_buf(),
        }
    }
}

/// The identity of the running NewPi, as the two project plugins need it.
///
/// It is read from this process rather than threaded through every call: the
/// identifier is the one `tauri.conf.json` was built with, and the bundle
/// directory exists only when NewPi runs from an `.app`. A `pnpm dev` launch is
/// a bare binary, and the Projects section offers a manual restart there rather
/// than a button that could not work.
#[derive(Debug, Clone)]
pub struct AppIdentity {
    /// The bundle identifier, e.g. `io.newpi.desktop`.
    pub id: &'static str,
    /// The `*.app` directory, when NewPi runs from one.
    pub bundle: Option<PathBuf>,
}

/// The identifier `tauri.conf.json` declares.
///
/// A test asserts the two agree, so renaming the application cannot leave the
/// Projects section's restart pointing at something that no longer exists.
pub const APP_IDENTIFIER: &str = "io.newpi.desktop";

impl AppIdentity {
    /// Resolve the identity of this process.
    ///
    /// @returns the identifier and, when there is one, the bundle directory.
    pub fn resolve() -> Self {
        Self {
            id: APP_IDENTIFIER,
            bundle: bundle_directory(),
        }
    }

    /// The bundle path as the launcher patch carries it, or an empty string.
    ///
    /// @returns the path, or `""` when NewPi is not running from a bundle.
    pub fn bundle_config(&self) -> String {
        self.bundle
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_default()
    }
}

/// The `*.app` directory holding this executable, when there is one.
///
/// The layout is fixed by macOS: `<name>.app/Contents/MacOS/<binary>`, so the
/// third ancestor of the executable is the bundle when (and only when) it is
/// spelled `.app`. Everything else — a `cargo run`, a `target/debug/newpi` —
/// is honestly reported as no bundle at all.
fn bundle_directory() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let bundle = executable.parent()?.parent()?.parent()?;
    match bundle.extension().and_then(|value| value.to_str()) {
        Some("app") => Some(bundle.to_path_buf()),
        _ => None,
    }
}

/// The entry file one row points at.
///
/// A development source wins over the deployed copy: that is the whole point of
/// the loop, and the deployed copy is not even written for a plugin the source
/// provides.
///
/// @param layout - the resolved layout.
/// @param dev - the development plugin source, when one is configured.
/// @param plugin - the plugin's directory name.
/// @returns the absolute `index.js` the launcher patch mounts.
fn entry(layout: &Layout, dev: Option<&crate::dev::DevSource>, plugin: &str) -> PathBuf {
    dev.and_then(|source| source.entry(plugin))
        .unwrap_or_else(|| layout.plugins.join(plugin).join("index.js"))
}

/// The project facts one launch's rows all share.
///
/// It exists so "no project open" is represented once, as empty strings,
/// instead of every row deciding for itself what an absent project means.
struct ProjectScope {
    /// The Project Model's project id, empty when none is open.
    id: String,
    /// The human name, empty when none is open.
    name: String,
    /// The memory namespace, empty when none is open.
    namespace: String,
    /// The project root, empty when none is open.
    root: String,
}

impl ProjectScope {
    /// Summarize the open project, if any.
    fn from(project: Option<&Project>) -> Self {
        match project {
            Some(project) => Self {
                id: project.id.clone(),
                name: project.name.clone(),
                namespace: project.namespace.clone(),
                root: project.root.display().to_string(),
            },
            None => Self {
                id: String::new(),
                name: String::new(),
                namespace: String::new(),
                root: String::new(),
            },
        }
    }
}

/// The launcher patch rows for one launch.
///
/// @param layout - the resolved layout, whose plugin paths the rows point at.
/// @param project - the open project scope, or `None` when none is open.
/// @param roots - the roots the storage console measures and is fenced by. Its
///   `workspace` is the open project's root, or empty when there is none.
/// @param mem0_installed - whether the profile declares Mem0, which decides
///   whether a non-destructive `disabled` row is worth emitting.
/// @param dev - the development plugin source, when `dev.json` names one.
/// @returns the rows, in application order.
pub fn rows(
    layout: &Layout,
    project: Option<&Project>,
    roots: &Roots,
    mem0_installed: bool,
    dev: Option<&crate::dev::DevSource>,
) -> Vec<Row> {
    let mut rows = Vec::with_capacity(10);

    // Every project fact one row carries comes from the same `Option`, so the
    // Project Model, Memory and Storage can never disagree about which project
    // is open — including the answer "none".
    let scope = ProjectScope::from(project);

    // The branding row has nothing to do with memory and is mounted whatever
    // the memory decision is: the product name is not an optional feature. It
    // carries the whale artwork, so the deployed plugin needs no second copy of
    // a file the repository already holds.
    rows.push(
        Row::plugin("newpi-brand", &entry(layout, dev, "newpi-brand"))
            .with_config("whale", crate::assets::whale_markup()),
    );

    // A user message sent while the agent works belongs after that work, not
    // in the steering channel that cancels it. The guard is page-only and has
    // no state or secret, so it is always safe to mount with the brand.
    rows.push(Row::plugin(
        "session-queue-guard",
        &entry(layout, dev, "session-queue-guard"),
    ));

    // The project model is the source of truth the other rows are keyed by: the
    // memory scope, the workspace root, and the state directory its registry
    // lives under. It carries no credential and no backend port — it has no
    // database behind it — so it is mounted whether or not a sidecar came up.
    // With no project open it carries empty strings, which is how the model is
    // told not to invent one from the directory the harness happens to run in.
    // The application's own identity, so the section can offer a clean restart
    // only where the system would actually find an application to open.
    let app = AppIdentity::resolve();
    rows.push(
        Row::plugin("project-model", &entry(layout, dev, "project-model"))
            .with_config("stateDir", layout.state.display().to_string())
            .with_config("workspace", scope.root.clone())
            .with_config("projectId", scope.id.clone())
            .with_config("name", scope.name.clone())
            .with_config("memoryNamespace", scope.namespace.clone())
            .with_config("appId", app.id)
            .with_config("appBundle", app.bundle_config()),
    );

    // The Projects section reads the model above and injects itself into the
    // rendered page. It owns no endpoint and no state of its own, so it stays
    // mounted whether or not a sidecar came up: choosing a project has nothing
    // to do with the memory database.
    rows.push(Row::plugin(
        "projects-console",
        &entry(layout, dev, "projects-console"),
    ));

    // The backend carries the project scope in its configuration: this is the
    // single place the scope enters the harness, and the provider reads it from
    // the service rather than from a tool argument. An empty scope is the
    // refusal, not a namespace: with no project open every memory call answers
    // `MEMORY_NO_PROJECT` instead of writing under a directory's name.
    rows.push(
        Row::plugin(
            "pocketbase-memory",
            &entry(layout, dev, "pocketbase-memory"),
        )
        .with_config("projectId", scope.namespace.clone()),
    );
    rows.push(Row::plugin(
        "memory-tools",
        &entry(layout, dev, "memory-tools"),
    ));

    // The console carries the two paths and the two versions its manifests
    // need, plus the open project's human name — a display fact, never a key.
    // None of them is a secret: the credential and the sidecar's URL stay in the
    // environment, where the interface cannot read them.
    rows.push(
        Row::plugin("memory-console", &entry(layout, dev, "memory-console"))
            .with_config("backupDir", layout.backups.display().to_string())
            .with_config("snapshotDir", layout.snapshots().display().to_string())
            .with_config("dataDir", layout.data.display().to_string())
            .with_config("newpiVersion", env!("CARGO_PKG_VERSION"))
            .with_config("pocketbaseVersion", crate::pocketbase::VERSION)
            .with_config("projectName", scope.name.clone()),
    );

    // The storage console names the roots and the state paths, and nothing
    // else. Every one of them is a directory NewPi already resolved, and the
    // plugin refuses any id that is not in its own catalog, so a browser
    // request can never become an arbitrary path. It is mounted whether or not
    // a sidecar came up: measuring a disk has nothing to do with memory. Its
    // `workspace` is the open project's root and empty when none is open, so no
    // project target ever hangs from the personal folder.
    rows.push(
        Row::plugin("storage-console", &entry(layout, dev, "storage-console"))
            .with_config("home", roots.home.display().to_string())
            .with_config("workspace", scope.root.clone())
            .with_config("stateDir", layout.state.display().to_string())
            .with_config("dshHome", roots.dsh_home.display().to_string())
            .with_config("dataDir", layout.data.display().to_string())
            .with_config("snapshotDir", layout.snapshots().display().to_string())
            .with_config("backupDir", layout.backups.display().to_string())
            .with_config("projectName", scope.name.clone()),
    );

    // The context & cache manager observes what a model call was made of and
    // what the provider charged for its cache. It has no configuration to
    // carry: an empty row mounts it with defaults, and it decides nothing, so
    // it is mounted whether or not a sidecar came up — and whether or not the
    // project declares a routing plan. Measuring a context has nothing to do
    // with memory, and nothing to do with routing.
    rows.push(Row::plugin(
        "context-cache-manager",
        &entry(layout, dev, "context-cache-manager"),
    ));

    // The console runs commands in the project's own directory, and that
    // directory travels in the row: the page names a command and nothing else,
    // so there is no directory for a browser to choose. It is mounted whether
    // or not a sidecar came up — running `git status` has nothing to do with
    // memory.
    rows.push(
        Row::plugin("terminal-console", &entry(layout, dev, "terminal-console"))
            .with_config("workspace", roots.workspace.display().to_string()),
    );

    if mem0_installed {
        rows.push(Row::disabled_package(
            MEM0_ROW_ID,
            "@deepseek-ai/dsh-memory-mem0",
        ));
    }

    rows
}

/// Whether the DSH profile declares a Mem0 memory plugin.
///
/// Read from the profile's `package.json` rather than guessed. When the package
/// is absent — the case on a default install — there is nothing to disable and
/// no inert row is written, which keeps the launcher patch honest about what it
/// actually does.
///
/// @param dsh_home - the harness home (`$DSH_HOME`).
/// @param profile - the profile name, normally `web`.
/// @returns whether any dependency name contains `mem0`.
pub fn mem0_installed(dsh_home: &Path, profile: &str) -> bool {
    let manifest = dsh_home.join("profiles").join(profile).join("package.json");
    let Ok(text) = std::fs::read_to_string(manifest) else {
        return false;
    };
    let lowered = text.to_ascii_lowercase();
    lowered.contains("mem0")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Projects section asks macOS to relaunch NewPi by bundle identifier.
    /// A renamed application would leave that button pointing at nothing, so
    /// the constant and the Tauri configuration are compared here.
    #[test]
    fn the_bundle_identifier_matches_the_tauri_configuration() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            config.get("identifier").and_then(|value| value.as_str()),
            Some(APP_IDENTIFIER),
        );
    }

    /// A launch from a bare binary is not a bundle, and the section must be
    /// told so rather than offering a restart the system cannot perform.
    #[test]
    fn a_launch_that_is_not_a_bundle_reports_no_bundle() {
        let app = AppIdentity::resolve();
        let bundle = app.bundle_config();
        if let Some(path) = &app.bundle {
            assert!(path.extension().and_then(|value| value.to_str()) == Some("app"));
        } else {
            assert_eq!(bundle, "");
        }
    }

    #[test]
    fn reads_the_project_id_from_the_project_configuration() {
        let text = "# a project\nmemory:\n  project_id: twin\nother:\n  x: 1\n";
        assert_eq!(project_id_in(text).as_deref(), Some("twin"));
    }

    #[test]
    fn reads_a_quoted_project_id_and_an_inline_comment() {
        assert_eq!(
            project_id_in("memory:\n  project_id: 'twin-prod'  # pinned\n").as_deref(),
            Some("twin-prod"),
        );
        assert_eq!(
            project_id_in("memory:\n  project_id: \"twin\"\n").as_deref(),
            Some("twin"),
        );
        assert_eq!(
            project_id_in("memory:\n  project_id: twin # note\n").as_deref(),
            Some("twin"),
        );
    }

    #[test]
    fn ignores_a_project_id_that_belongs_to_another_block() {
        // Deeper than a direct child of `memory:`.
        assert_eq!(
            project_id_in("memory:\n  nested:\n    project_id: nope\n"),
            None
        );
        // A different top level block entirely.
        assert_eq!(project_id_in("other:\n  project_id: nope\n"), None);
    }

    #[test]
    fn ignores_a_configuration_that_names_no_project() {
        assert_eq!(project_id_in("memory:\n  enabled: true\n"), None);
        assert_eq!(project_id_in(""), None);
        assert_eq!(project_id_in("memory:\n  project_id:\n"), None);
    }

    #[test]
    fn derives_a_readable_identifier_from_a_directory_name() {
        assert_eq!(derived_id(Path::new("/Users/x/Documents/twin")), "twin");
        assert_eq!(derived_id(Path::new("/Users/x/My Project!")), "my-project");
        assert_eq!(derived_id(Path::new("/")), "default");
    }

    #[test]
    fn resolve_prefers_the_project_configuration() {
        let workspace = std::env::temp_dir().join("newpi-project-test");
        let config = workspace.join(PROJECT_CONFIG);
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(&config, "memory:\n  project_id: pinned\n").unwrap();

        let project = Project::resolve(&workspace).unwrap();
        assert_eq!(project.id, "pinned");
        assert_eq!(project.source.as_deref(), Some(config.as_path()));

        // And falls back to the directory name without one.
        std::fs::remove_file(&config).unwrap();
        let derived = Project::resolve(&workspace).unwrap();
        assert_eq!(derived.id, "newpi-project-test");
        assert!(derived.source.is_none());

        std::fs::remove_dir_all(&workspace).unwrap();
    }

    #[test]
    fn the_launcher_rows_name_every_plugin_with_a_file_url() {
        let layout = Layout::new(Path::new("/state"));
        let project = Project {
            id: "twin".to_string(),
            name: "Twin display".to_string(),
            namespace: "twin".to_string(),
            root: PathBuf::from("/workspace"),
            source: None,
        };
        let roots = Roots::new(
            Path::new("/workspace"),
            Path::new("/home"),
            Path::new("/home/.dsh"),
        );
        let rows = rows(&layout, Some(&project), &roots, true, None);
        assert_eq!(rows.len(), 11);

        // The branding row comes first and is mounted whatever else the launch
        // decides. It carries the whale artwork so the deployed plugin needs no
        // second copy of a file the repository already holds.
        assert_eq!(rows[0].id, "newpi-brand");
        assert!(rows[0].name.starts_with("file://"));
        assert!(rows[0].name.ends_with("/plugins/newpi-brand/index.js"));
        assert!(!rows[0].disabled);
        let whale = rows[0]
            .config
            .get("whale")
            .expect("the mark artwork is missing");
        assert!(
            whale.starts_with("<svg"),
            "the XML declaration must be stripped"
        );
        assert!(whale.contains("</svg>"));
        assert!(!whale.contains("<?xml"));

        // The project model is the source of truth the other rows are keyed by.
        // It names the state directory, the workspace root, the scope and the
        // namespace, and nothing that could be a credential or a port.
        let model = rows.iter().find(|row| row.id == "project-model").unwrap();
        assert!(model.name.starts_with("file://"));
        assert!(model.name.ends_with("/plugins/project-model/index.js"));
        assert!(!model.disabled);
        assert_eq!(
            model.config.keys().collect::<Vec<_>>(),
            vec![
                "appBundle",
                "appId",
                "memoryNamespace",
                "name",
                "projectId",
                "stateDir",
                "workspace"
            ],
            "the project row must carry the project facts and nothing else",
        );
        assert_eq!(
            model.config.get("stateDir").map(String::as_str),
            Some("/state")
        );
        assert_eq!(
            model.config.get("workspace").map(String::as_str),
            Some("/workspace")
        );
        assert_eq!(
            model.config.get("projectId").map(String::as_str),
            Some("twin")
        );
        assert_eq!(
            model.config.get("name").map(String::as_str),
            Some("Twin display")
        );
        assert_eq!(
            model.config.get("memoryNamespace").map(String::as_str),
            Some("twin")
        );

        let backend = rows
            .iter()
            .find(|row| row.id == "pocketbase-memory")
            .unwrap();
        assert!(backend.name.starts_with("file://"));
        assert!(backend
            .name
            .ends_with("/plugins/pocketbase-memory/index.js"));
        assert_eq!(
            backend.config.get("projectId").map(String::as_str),
            Some("twin")
        );

        let tools = rows.iter().find(|row| row.id == "memory-tools").unwrap();
        assert!(tools.name.ends_with("/plugins/memory-tools/index.js"));
        assert!(tools.config.is_empty());

        // The console row carries the two paths and the two versions its
        // manifests are built from — and no credential, no port, no URL.
        let console = rows.iter().find(|row| row.id == "memory-console").unwrap();
        assert!(console.name.starts_with("file://"));
        assert!(console.name.ends_with("/plugins/memory-console/index.js"));
        assert_eq!(
            console.config.get("backupDir").map(String::as_str),
            Some("/state/backups"),
        );
        assert_eq!(
            console.config.get("snapshotDir").map(String::as_str),
            Some("/state/pocketbase/pb_data/backups"),
        );
        assert_eq!(
            console.config.get("dataDir").map(String::as_str),
            Some("/state/pocketbase/pb_data"),
        );
        assert_eq!(
            console.config.get("pocketbaseVersion").map(String::as_str),
            Some(crate::pocketbase::VERSION),
        );
        assert_eq!(
            console.config.get("newpiVersion").map(String::as_str),
            Some(env!("CARGO_PKG_VERSION")),
        );
        // The console shows the open project's human name; it is a display
        // fact, never the namespace the memories are keyed by.
        assert_eq!(
            console.config.get("projectName").map(String::as_str),
            Some("Twin display"),
        );
        assert!(
            console
                .config
                .keys()
                .all(|key| !key.to_ascii_lowercase().contains("password")),
            "the console row must never carry a credential",
        );

        // The storage row names the roots and the state paths. Every value is a
        // directory NewPi resolved, and the plugin refuses any id that is not in
        // its own catalog — so no key here is a target the browser can redirect,
        // and none is a secret.
        let storage = rows.iter().find(|row| row.id == "storage-console").unwrap();
        assert!(storage.name.starts_with("file://"));
        assert!(storage.name.ends_with("/plugins/storage-console/index.js"));
        assert!(!storage.disabled);
        assert_eq!(
            storage.config.keys().collect::<Vec<_>>(),
            vec![
                "backupDir",
                "dataDir",
                "dshHome",
                "home",
                "projectName",
                "snapshotDir",
                "stateDir",
                "workspace",
            ],
            "the storage row must carry the roots and nothing else",
        );
        assert_eq!(
            storage.config.get("workspace").map(String::as_str),
            Some("/workspace")
        );
        assert_eq!(
            storage.config.get("projectName").map(String::as_str),
            Some("Twin display")
        );
        assert_eq!(
            storage.config.get("home").map(String::as_str),
            Some("/home")
        );
        assert_eq!(
            storage.config.get("dshHome").map(String::as_str),
            Some("/home/.dsh")
        );
        assert_eq!(
            storage.config.get("stateDir").map(String::as_str),
            Some("/state")
        );
        assert_eq!(
            storage.config.get("dataDir").map(String::as_str),
            Some("/state/pocketbase/pb_data"),
        );
        assert_eq!(
            storage.config.get("backupDir").map(String::as_str),
            Some("/state/backups")
        );
        assert!(
            storage
                .config
                .keys()
                .all(|key| !key.to_ascii_lowercase().contains("password")),
            "the storage row must never carry a credential",
        );

        // The context & cache manager is mounted unconditionally and carries no
        // configuration at all: it observes, it decides nothing, and there is
        // therefore no key here that could become a second policy.
        let manager = rows
            .iter()
            .find(|row| row.id == "context-cache-manager")
            .unwrap();
        assert!(manager.name.starts_with("file://"));
        assert!(manager
            .name
            .ends_with("/plugins/context-cache-manager/index.js"));
        assert!(!manager.disabled);
        assert!(
            manager.config.is_empty(),
            "the context & cache manager has nothing to configure",
        );

        let mem0 = rows.iter().find(|row| row.id == MEM0_ROW_ID).unwrap();
        assert!(mem0.disabled, "Mem0 must be disabled, not removed");
    }

    #[test]
    fn the_backups_directory_is_a_sibling_of_the_sidecar_data() {
        // Intent, not decoration: PocketBase prunes the directory it owns, so a
        // backup the user asked for must not be inside it.
        let layout = Layout::new(Path::new("/state"));
        assert_eq!(layout.backups, Path::new("/state/backups"));
        assert_eq!(
            layout.snapshots(),
            Path::new("/state/pocketbase/pb_data/backups")
        );
        assert!(!layout.snapshots().starts_with(&layout.backups));

        let state = std::env::temp_dir().join("newpi-layout-test");
        let _ = std::fs::remove_dir_all(&state);
        Layout::new(&state).create().unwrap();
        assert!(
            state.join("backups").is_dir(),
            "create() must make the backups directory",
        );
        std::fs::remove_dir_all(&state).unwrap();
    }

    #[test]
    fn no_disable_row_is_written_when_mem0_is_absent() {
        let layout = Layout::new(Path::new("/state"));
        let project = Project {
            id: "twin".to_string(),
            name: "twin".to_string(),
            namespace: "twin".to_string(),
            root: PathBuf::from("/workspace"),
            source: None,
        };
        let roots = Roots::new(
            Path::new("/workspace"),
            Path::new("/home"),
            Path::new("/home/.dsh"),
        );
        let rows = rows(&layout, Some(&project), &roots, false, None);
        assert_eq!(rows.len(), 10);
        assert!(rows.iter().all(|row| !row.disabled));
        assert!(rows.iter().any(|row| row.id == "newpi-brand"));
        assert!(rows.iter().any(|row| row.id == "session-queue-guard"));
        assert!(rows.iter().any(|row| row.id == "project-model"));
        assert!(rows.iter().any(|row| row.id == "projects-console"));
        assert!(rows.iter().any(|row| row.id == "memory-console"));
        assert!(rows.iter().any(|row| row.id == "storage-console"));
        assert!(rows.iter().any(|row| row.id == "context-cache-manager"));
        assert!(rows.iter().any(|row| row.id == "terminal-console"));
    }

    #[test]
    fn deploy_writes_the_plugins_and_prunes_stale_modules() {
        let state = std::env::temp_dir().join("newpi-deploy-test");
        let _ = std::fs::remove_dir_all(&state);
        let layout = Layout::new(&state);
        layout.create().unwrap();

        let backend = layout.plugins.join("pocketbase-memory");
        std::fs::create_dir_all(&backend).unwrap();
        std::fs::write(backend.join("removed-later.js"), "// stale").unwrap();

        // A stale file *inside a plugin's own subdirectory* is the case the
        // walk exists for: a module left behind below a plugin directory would
        // keep being imported, and the walk is what removes it.
        let nested = layout.plugins.join("pocketbase-memory").join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("removed-later.json"), "{}").unwrap();

        // A plugin the application no longer ships, left behind by an older
        // build: the launcher patch does not mount it, and the acceptance check
        // reads the two sets against each other, so it has to go.
        let stale = layout.plugins.join("gone-console");
        std::fs::create_dir_all(stale.join("inner")).unwrap();
        std::fs::write(stale.join("inner/left.js"), "// stale").unwrap();

        // And the module tree the deploy does not own: it is a symlink, and a
        // prune that followed it would delete the harness's packages.
        let modules = layout.plugins.join("node_modules");
        if !modules.exists() {
            std::os::unix::fs::symlink(std::env::temp_dir(), &modules).unwrap();
        }

        let (written, removed) = deploy_assets(&layout, None).unwrap();
        assert!(written >= 5, "expected every embedded file to be written");
        assert_eq!(
            removed, 3,
            "two stale files and one stale plugin must be pruned"
        );
        assert!(!backend.join("removed-later.js").exists());
        assert!(!nested.join("removed-later.json").exists());
        assert!(
            !stale.exists(),
            "a plugin the build no longer ships must be removed"
        );
        assert!(
            modules.exists(),
            "the module tree is not this deploy's to remove"
        );
        assert!(layout.migrations.join(crate::assets::MIGRATION.0).is_file());

        // A second pass is a no-op: nothing is rewritten when nothing changed.
        let (written, removed) = deploy_assets(&layout, None).unwrap();
        assert_eq!((written, removed), (0, 0));

        std::fs::remove_dir_all(&state).unwrap();
    }

    #[test]
    fn a_development_source_keeps_its_plugins_out_of_the_deploy() {
        let state = std::env::temp_dir().join("newpi-deploy-dev-test");
        let _ = std::fs::remove_dir_all(&state);
        let layout = Layout::new(&state);
        layout.create().unwrap();

        // The repository (or whatever directory the developer named) provides
        // two plugins: one the manifest also ships, one it does not.
        let dev_root = state.join("dev");
        std::fs::create_dir_all(dev_root.join("model-router")).unwrap();
        std::fs::write(
            dev_root.join("model-router/index.js"),
            "// from the repository",
        )
        .unwrap();
        std::fs::write(
            dev_root.join("model-router/adaptive.js"),
            "// only the repository has this",
        )
        .unwrap();
        std::fs::create_dir_all(dev_root.join("local-console")).unwrap();
        std::fs::write(
            dev_root.join("local-console/index.js"),
            "// a plugin only the source has",
        )
        .unwrap();
        let source = crate::dev::DevSource::parse(
            &format!("{{\"pluginsDir\": \"{}\"}}", dev_root.display()),
            &state,
        )
        .unwrap();

        // Stale state the deploy would normally own: a deployed copy of a
        // provided plugin, and a directory belonging to no shipped plugin.
        std::fs::create_dir_all(layout.plugins.join("model-router")).unwrap();
        std::fs::write(
            layout.plugins.join("model-router/index.js"),
            "// an old embedded build",
        )
        .unwrap();
        std::fs::create_dir_all(layout.plugins.join("local-console")).unwrap();
        std::fs::write(layout.plugins.join("local-console/index.js"), "// stale").unwrap();

        let (written, removed) = deploy_assets(&layout, Some(&source)).unwrap();
        assert!(
            written > 0,
            "every plugin the source does not provide is still deployed"
        );
        assert_eq!(
            removed, 0,
            "nothing the source provides is this deploy's to remove"
        );
        assert_eq!(
            std::fs::read_to_string(dev_root.join("model-router/index.js")).unwrap(),
            "// from the repository",
            "the source's own file is never rewritten",
        );
        assert!(dev_root.join("model-router/adaptive.js").is_file());
        assert!(layout.plugins.join("newpi-brand/index.js").is_file());
        assert!(
            layout.plugins.join("local-console/index.js").is_file(),
            "a directory the source provides survives the prune",
        );

        std::fs::remove_dir_all(&state).unwrap();
    }
}
