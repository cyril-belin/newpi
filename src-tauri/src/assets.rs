//! The harness-side half of the memory feature, embedded in the binary.
//!
//! NewPi ships two kinds of file that only the harness ever reads:
//!
//! - the Cordis plugins, which the harness imports as modules;
//! - one PocketBase migration, which the sidecar applies at startup.
//!
//! All of them are compiled into the executable with `include_str!` and written
//! to the application's state directory on every launch. Embedding them, rather
//! than copying them out of a resource directory, buys three things that matter
//! here:
//!
//! - **No second signature.** A directory of `.js` files added to
//!   `Contents/Resources` is sealed by the code signature of the bundle that
//!   contains it, and any later edit invalidates that seal. Bytes carried
//!   inside the executable cannot invalidate it.
//! - **One version.** The plugin code and the Rust code that configures it are
//!   compiled together, so a stale plugin can never meet a newer patch format.
//! - **A writable home.** The harness reads plugin modules from disk and needs
//!   them somewhere it may read; `Application Support` is writable by the user
//!   and survives application updates, which a read-only bundle is not.
//!
//! The files on disk are refreshed when their content changes, so editing a
//! plugin and relaunching is enough — no manual copy step, and no stale file
//! left behind.

/// The memory backend plugin: connection, service, and the PocketBase client.
pub const MEMORY_BACKEND: &[(&str, &str)] = &[
    (
        "index.js",
        include_str!("../../plugins/pocketbase-memory/index.js"),
    ),
    (
        "core.js",
        include_str!("../../plugins/pocketbase-memory/core.js"),
    ),
    (
        "client.js",
        include_str!("../../plugins/pocketbase-memory/client.js"),
    ),
    (
        "environment.js",
        include_str!("../../plugins/pocketbase-memory/environment.js"),
    ),
];

/// The provider plugin: the `remember`, `recall` and `forget` tools.
pub const MEMORY_TOOLS: &[(&str, &str)] = &[
    (
        "index.js",
        include_str!("../../plugins/memory-tools/index.js"),
    ),
    (
        "tools.js",
        include_str!("../../plugins/memory-tools/tools.js"),
    ),
];

/** The branding plugin: the product name in the interface's own title. */
pub const BRAND: &[(&str, &str)] = &[(
    "index.js",
    include_str!("../../plugins/newpi-brand/index.js"),
)];

/// The session queue guard: it changes only the Harness prompt delivery mode
/// from interrupting to queued, so a status message cannot discard live work.
pub const SESSION_QUEUE_GUARD: &[(&str, &str)] = &[(
    "index.js",
    include_str!("../../plugins/session-queue-guard/index.js"),
)];

/// The console plugin: the Memory and Backup sections, and the one
/// authenticated endpoint behind them.
///
/// It is the only plugin that renders anything a person clicks, and the only
/// one whose files a person reads: `ui.js` holds the two sections, `backup.js`
/// the archive format, `platform.js` every local command it runs.
pub const MEMORY_CONSOLE: &[(&str, &str)] = &[
    (
        "index.js",
        include_str!("../../plugins/memory-console/index.js"),
    ),
    ("ui.js", include_str!("../../plugins/memory-console/ui.js")),
    (
        "backup.js",
        include_str!("../../plugins/memory-console/backup.js"),
    ),
    (
        "platform.js",
        include_str!("../../plugins/memory-console/platform.js"),
    ),
];

/**
 * The storage console: the Storage section, its endpoint, and the catalog of
 * targets it is allowed to look at and to clean.
 *
 * `catalog.js` is the policy — what each directory is for, whether it is
 * reconstructible, and how much of it is within budget. `scan.js` measures,
 * `cleanup.js` removes, `ui.js` renders, and `index.js` fences the endpoint.
 * A target that is not in the catalog cannot be named from the browser, and a
 * target the catalog marks `guarded` cannot be removed at all.
 */
pub const STORAGE_CONSOLE: &[(&str, &str)] = &[
    (
        "index.js",
        include_str!("../../plugins/storage-console/index.js"),
    ),
    (
        "catalog.js",
        include_str!("../../plugins/storage-console/catalog.js"),
    ),
    (
        "cleanup.js",
        include_str!("../../plugins/storage-console/cleanup.js"),
    ),
    (
        "scan.js",
        include_str!("../../plugins/storage-console/scan.js"),
    ),
    ("ui.js", include_str!("../../plugins/storage-console/ui.js")),
];

/**
 * The model router: the routing policy, its configuration contract, and its
 * decisions.
 *
 * `plan.js` is the contract the launcher patch carries as one JSON scalar,
 * validated on both sides; `routing.js` holds the pure policy — which failure
 * may fall back, what a provider's metadata means as a capability, how a
 * diagnostic is scrubbed. `index.js` owns the state and the Cordis service;
 * `adaptive.js` owns the selectable `Adaptive` route — its catalog, its
 * metadata, and the request rewrite that keeps the logged route truthful.
 */
pub const MODEL_ROUTER: &[(&str, &str)] = &[
    (
        "index.js",
        include_str!("../../plugins/model-router/index.js"),
    ),
    (
        "adaptive.js",
        include_str!("../../plugins/model-router/adaptive.js"),
    ),
    (
        "plan.js",
        include_str!("../../plugins/model-router/plan.js"),
    ),
    (
        "routing.js",
        include_str!("../../plugins/model-router/routing.js"),
    ),
];

/**
 * The Context & Cache Manager: the context layer model, the handoff and prefix
 * versions, and the per-call cache telemetry.
 *
 * `context.js` is the layer vocabulary and the version ledger — every
 * contribution reduced to a digest and a count, so no prompt text is ever
 * retained. `cache.js` is the arithmetic over the provider's own counters and
 * the hot/warm/cold estimate; it never invents a cache. `index.js` is the
 * Cordis service and the three observational seams.
 */
pub const CONTEXT_CACHE_MANAGER: &[(&str, &str)] = &[
    (
        "index.js",
        include_str!("../../plugins/context-cache-manager/index.js"),
    ),
    (
        "context.js",
        include_str!("../../plugins/context-cache-manager/context.js"),
    ),
    (
        "cache.js",
        include_str!("../../plugins/context-cache-manager/cache.js"),
    ),
];

/**
 * The Project Model: the one current project, its registry, its sessions, its
 * memory namespace, its handoff and UI state, and the two guardrails.
 *
 * `model.js` is the rule set — what a project is, what it may do, and which
 * operation may move it — and carries no I/O, so it is testable on its own.
 * `store.js` is the one small JSON document under NewPi's state directory.
 * `platform.js` is the two host operations the interface needs — a native
 * folder panel and a clean relaunch — and is the only file here that runs a
 * command. `git.js` is the Git seam: the exact-root fence, the refusals for
 * nested repositories and submodules, structured argv, and the six verbs the
 * interface may ask for. `index.js` is the Cordis service
 * (`ctx.projectModel`) and the optional seams it binds: the harness's own
 * workspace registry, the live session store, the Context & Cache Manager, and
 * the authenticated endpoint.
 */
pub const PROJECT_MODEL: &[(&str, &str)] = &[
    (
        "index.js",
        include_str!("../../plugins/project-model/index.js"),
    ),
    (
        "model.js",
        include_str!("../../plugins/project-model/model.js"),
    ),
    (
        "store.js",
        include_str!("../../plugins/project-model/store.js"),
    ),
    (
        "platform.js",
        include_str!("../../plugins/project-model/platform.js"),
    ),
    ("git.js", include_str!("../../plugins/project-model/git.js")),
];

/**
 * The Projects section: which project is open, which are recent, and how to
 * change project without naming a path or a command.
 *
 * `ui.js` is the injected section — one style and one script, spliced into the
 * rendered index, with the sidebar row and the overlay panel. `index.js` is the
 * thin Cordis service that reads the two host facts the page cannot compute and
 * mounts the section. It owns no endpoint: every project fact and action goes
 * through `ctx.projectModel` and the route the Project Model already registers.
 */
pub const PROJECTS_CONSOLE: &[(&str, &str)] = &[
    (
        "index.js",
        include_str!("../../plugins/projects-console/index.js"),
    ),
    (
        "ui.js",
        include_str!("../../plugins/projects-console/ui.js"),
    ),
];

/**
 * The console section: one command at a time in the project's own directory,
 * with the output streamed into the interface.
 *
 * `terminal.js` is the contract the two sides share — the route, the
 * newline-delimited frame format, and the reduction of terminal output to plain
 * text, so the panel needs no emulator. `index.js` owns the authenticated route
 * and the process it starts (its own group, so a build or a watcher stops
 * whole). `ui.js` is the injected panel: a real function, syntax-checked and
 * run against a fake DOM by the test suite, then serialised into the page.
 */
pub const TERMINAL_CONSOLE: &[(&str, &str)] = &[
    (
        "index.js",
        include_str!("../../plugins/terminal-console/index.js"),
    ),
    (
        "terminal.js",
        include_str!("../../plugins/terminal-console/terminal.js"),
    ),
    (
        "ui.js",
        include_str!("../../plugins/terminal-console/ui.js"),
    ),
];

/// The sidebar mark: the whale NewPi shows where the engine showed its own.
///
/// Passed to the branding plugin as plugin configuration, which the launcher
/// patch renders as one YAML scalar. The XML declaration is dropped because the
/// markup is embedded in an HTML document, where a second declaration would be
/// an error rather than a formality; everything after it is byte for byte the
/// file the repository ships.
pub fn whale_markup() -> &'static str {
    let raw = include_str!("../../assets/whale.svg");
    match raw.find("<svg") {
        Some(at) => &raw[at..],
        None => raw,
    }
}

/// The versioned PocketBase migration, applied by the sidecar at startup.
pub const MIGRATION: (&str, &str) = (
    "1789230000_create_memories_collection.js",
    include_str!("../../pb_migrations/1789230000_create_memories_collection.js"),
);

/// Every embedded plugin, keyed by its directory name under `plugins/`.
///
/// The directory name is the row id NewPi writes into the launcher patch, so
/// this table is the one place where a plugin's on-disk name and its module id
/// are tied together.
pub const PLUGINS: &[(&str, &[(&str, &str)])] = &[
    ("pocketbase-memory", MEMORY_BACKEND),
    ("memory-tools", MEMORY_TOOLS),
    ("memory-console", MEMORY_CONSOLE),
    ("storage-console", STORAGE_CONSOLE),
    ("model-router", MODEL_ROUTER),
    ("context-cache-manager", CONTEXT_CACHE_MANAGER),
    ("project-model", PROJECT_MODEL),
    ("projects-console", PROJECTS_CONSOLE),
    ("terminal-console", TERMINAL_CONSOLE),
    ("newpi-brand", BRAND),
    ("session-queue-guard", SESSION_QUEUE_GUARD),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_embedded_plugin_declares_apply_and_no_default_export() {
        for (label, files) in PLUGINS {
            let entry = files
                .iter()
                .find(|(name, _)| *name == "index.js")
                .map(|(_, source)| *source)
                .unwrap_or_else(|| panic!("{label} has no index.js"));
            // The loader unwraps a module with a `default` export down to that
            // value, which would discard `inject` and `name`. Guarding the
            // embedded copy here is what keeps that mistake out of a release.
            assert!(
                !entry.contains("export default"),
                "{label} must not have a default export",
            );
            assert!(
                entry.contains("export function apply"),
                "{label} must export apply",
            );
            assert!(
                entry.contains("export const inject"),
                "{label} must export inject",
            );
        }
    }

    /// Every file a plugin directory holds is embedded, and nothing else is.
    ///
    /// The tables above are written by hand, so a file added to a plugin stays
    /// invisible to the packaged application until someone remembers to add it.
    /// That is not a theoretical risk: a module a plugin's host half imported
    /// was left out, and the deployed plugin failed to import — which the
    /// Cordis loader treats as a failed launch, so the harness exited instead
    /// of serving the interface. The isolated probe could not see it, because
    /// its launcher patch named the repository, where the file does exist.
    ///
    /// Comparing the directory to the table is what makes the omission
    /// impossible to repeat, including for a file no module imports.
    #[test]
    fn every_plugin_file_on_disk_is_embedded() {
        use std::path::Path;

        for (plugin, files) in PLUGINS {
            let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../plugins")
                .join(plugin);
            let mut on_disk = Vec::new();
            collect_files(&directory, &directory, &mut on_disk);
            on_disk.sort();

            let mut embedded: Vec<String> =
                files.iter().map(|(name, _)| (*name).to_owned()).collect();
            embedded.sort();

            assert_eq!(
                on_disk, embedded,
                "{plugin}: the embedded set and the plugin directory disagree",
            );
        }
    }

    /// Collect every file below `directory`, named relative to `root`.
    fn collect_files(root: &std::path::Path, directory: &std::path::Path, into: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_files(root, &path, into);
            } else if let Ok(relative) = path.strip_prefix(root) {
                into.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }
    }

    #[test]
    fn the_migration_creates_the_memories_collection() {
        let (name, source) = MIGRATION;
        assert!(name.ends_with(".js"));
        for needle in [
            "name: 'memories'",
            "name: 'content'",
            "name: 'project_id'",
            "name: 'kind'",
            "name: 'created_at'",
            "idx_memories_project_kind",
            "idx_memories_project_created",
        ] {
            assert!(source.contains(needle), "migration is missing {needle}");
        }
        // Every rule stays null: the collection is superuser-only.
        assert_eq!(source.matches("Rule: null").count(), 5);
    }

    #[test]
    fn plugin_files_are_small_enough_to_embed_without_thought() {
        // A guard, not a budget: this is here so a future plugin that grows a
        // build step or a dependency gets noticed at test time. The limit is
        // what it is because the table carries every plugin NewPi ships. A
        // second dependency, or a vendored runtime, would show up here first.
        let total: usize = PLUGINS
            .iter()
            .flat_map(|(_, files)| files.iter())
            .map(|(_, source)| source.len())
            .sum();
        assert!(
            total < 3 * 1024 * 1024,
            "embedded plugins grew to {total} bytes"
        );
    }
}
