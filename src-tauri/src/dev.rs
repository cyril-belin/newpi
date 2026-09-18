//! The development loop: a plugin directory the application reads *instead of*
//! its embedded copies, and an optional watcher that restarts the runtime when
//! one of those files changes.
//!
//! # Why this exists
//!
//! The shipped plugins are compiled into the executable with `include_str!`, so
//! changing one JavaScript line otherwise costs a full rebuild of the
//! application. That is the right trade for a release — one self-contained
//! bundle, no file to lose — and the wrong one for a person iterating on a
//! plugin, who expects the loop a normal editor gives: save, and the running
//! application uses the new file.
//!
//! # The switch
//!
//! One optional file in the state directory, `dev.json`:
//!
//! ```json
//! { "pluginsDir": "/Users/you/src/NewPi/plugins", "reload": true }
//! ```
//!
//! With `pluginsDir` set, the launcher patch mounts `<pluginsDir>/<plugin>/index.js`
//! for every plugin that directory actually provides, and the deploy stops
//! owning those plugins: it never overwrites them, never prunes them. Absence
//! of the file is the shipped behaviour, and a malformed file is reported and
//! ignored — it costs the developer the loop, never the application.
//!
//! With `reload` true as well, a watcher polls the tree and restarts the
//! runtime once the writes settle, so a save is enough. It is off by default on
//! purpose: restarting the runtime ends the sessions it is serving, and a
//! developer who is *also* talking to the agent in that window does not want a
//! save to cut the answer in half.
//!
//! @module newpi::dev

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, UNIX_EPOCH};

use serde_json::Value;
use tauri::{AppHandle, Manager};

/// State-directory file that turns the loop on.
pub const DEV_FILENAME: &str = "dev.json";

/// How often the watcher looks at the tree.
const POLL: Duration = Duration::from_millis(1000);

/// How long the tree must stop changing before the runtime is restarted.
const SETTLE: Duration = Duration::from_millis(700);

/// A resolved development plugin source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevSource {
    plugins: PathBuf,
    reload: bool,
}

impl DevSource {
    /// Read `dev.json` from the state directory.
    ///
    /// Every way this can disappoint — no file, unreadable, not JSON, no
    /// `pluginsDir`, a directory that is not one — is reported and answered with
    /// `None`, because the alternative would be an application that refuses to
    /// start over a helper file.
    ///
    /// @param state - the application's state directory.
    /// @returns the source, when the file names a usable directory.
    pub fn read(state: &Path) -> Option<Self> {
        let path = state.join(DEV_FILENAME);
        let text = fs::read_to_string(&path).ok()?;
        match Self::parse(&text, state) {
            Ok(source) => {
                eprintln!(
                    "[newpi/dev] plugins de développement : {} (rechargement {})",
                    source.plugins.display(),
                    if source.reload { "actif" } else { "inactif" },
                );
                Some(source)
            }
            Err(error) => {
                eprintln!("[newpi/dev] {error}");
                None
            }
        }
    }

    /// Parse the document against the directory it is resolved from.
    ///
    /// `pluginsDir` may be relative, in which case it is relative to the state
    /// directory — which is what makes a checked-in `dev.json` copyable.
    ///
    /// @param text - the document.
    /// @param state - the state directory, for a relative path.
    /// @returns the source, or a message naming what is wrong.
    pub fn parse(text: &str, state: &Path) -> Result<Self, String> {
        let document: Value =
            serde_json::from_str(text).map_err(|error| format!("{DEV_FILENAME} illisible : {error}"))?;
        let declared = document
            .get("pluginsDir")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{DEV_FILENAME} : `pluginsDir` manquant"))?;
        let plugins = if Path::new(declared).is_absolute() {
            PathBuf::from(declared)
        } else {
            state.join(declared)
        };
        if !plugins.is_dir() {
            return Err(format!(
                "{DEV_FILENAME} : {} n'est pas un dossier",
                plugins.display(),
            ));
        }
        Ok(Self {
            plugins,
            reload: document.get("reload").and_then(Value::as_bool).unwrap_or(false),
        })
    }

    /// Whether the watcher should restart the runtime on a change.
    #[must_use]
    pub fn reload(&self) -> bool {
        self.reload
    }

    /// The entry file this source provides for one plugin.
    ///
    /// @param plugin - the plugin's directory name.
    /// @returns the absolute `index.js`, when that directory provides one.
    #[must_use]
    pub fn entry(&self, plugin: &str) -> Option<PathBuf> {
        let entry = self.plugins.join(plugin).join("index.js");
        entry.is_file().then_some(entry)
    }

    /// A cheap fingerprint of the whole tree: every file's path, size and
    /// modification time.
    ///
    /// Deliberately not a content hash: the watcher only has to notice that a
    /// write happened, and reading every byte once a second would be a strange
    /// price for that. A same-size write inside the same second is the one miss
    /// this accepts, and the next save catches it.
    ///
    /// @returns the fingerprint.
    #[must_use]
    pub fn fingerprint(&self) -> u64 {
        let mut files = BTreeMap::new();
        collect(&self.plugins, &mut files);
        // FNV-1a over the ordered walk: stable across runs, no dependency.
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for (path, stamp) in files {
            for byte in path.to_string_lossy().as_bytes().iter().chain(&stamp.to_le_bytes()) {
                hash ^= u64::from(*byte);
                hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
            }
        }
        hash
    }
}

/// One file's contribution to a fingerprint: size and modification time.
fn stamp(path: &Path) -> u64 {
    let Ok(metadata) = fs::metadata(path) else {
        return 0;
    };
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_secs());
    metadata.len() ^ (modified << 20)
}

/// Collect every file below `directory`, keyed by absolute path.
fn collect(directory: &Path, files: &mut BTreeMap<PathBuf, u64>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            collect(&path, files);
        } else if path.extension().is_some_and(|extension| extension == "js") {
            files.insert(path.clone(), stamp(&path));
        }
    }
}

/// Watch a development source and restart the runtime when its files settle.
///
/// One thread per launch, and only when `reload` was asked for. The restart is
/// the one a person gets by quitting and reopening the application: the window
/// is reused, and the runtime starts fresh on a fresh port.
///
/// @param app - the application handle, used to restart the runtime.
/// @param source - the resolved development source.
pub fn spawn_watcher(app: AppHandle, source: DevSource) {
    thread::spawn(move || {
        let mut last = source.fingerprint();
        loop {
            thread::sleep(POLL);
            let current = source.fingerprint();
            if current == last {
                continue;
            }
            // A save is rarely one write: an editor writes, renames, writes
            // again. Wait for the tree to hold still before paying for a
            // restart the developer does not need.
            loop {
                thread::sleep(SETTLE);
                let settled = source.fingerprint();
                if settled == last {
                    break;
                }
                last = settled;
            }
            last = current;
            eprintln!("[newpi/dev] plugins modifiés : redémarrage du runtime");
            let state = app.state::<crate::NewPi>();
            state.restart_runtime(&app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    /// A unique temporary directory for one test.
    fn scratch(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("newpi-dev-{label}-{unique}"));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn a_missing_or_wrong_document_is_reported_and_ignored() {
        let state = scratch("parse");
        assert_eq!(DevSource::read(&state), None, "no file, no loop");

        fs::write(state.join(DEV_FILENAME), "{ not json").unwrap();
        assert_eq!(DevSource::read(&state), None);

        fs::write(state.join(DEV_FILENAME), "{\"reload\": true}").unwrap();
        assert_eq!(DevSource::read(&state), None, "pluginsDir is what makes a source");

        fs::write(state.join(DEV_FILENAME), "{\"pluginsDir\": \"nowhere\"}").unwrap();
        assert_eq!(DevSource::read(&state), None, "a directory that is not one is refused");

        fs::remove_dir_all(&state).unwrap();
    }

    #[test]
    fn a_relative_plugins_dir_resolves_against_the_state_directory() {
        let state = scratch("relative");
        fs::create_dir_all(state.join("plugins/model-router")).unwrap();
        fs::write(state.join("plugins/model-router/index.js"), "// entry").unwrap();
        fs::write(state.join(DEV_FILENAME), "{\"pluginsDir\": \"plugins\", \"reload\": true}").unwrap();

        let source = DevSource::read(&state).unwrap();
        assert!(source.reload());
        assert_eq!(
            source.entry("model-router"),
            Some(state.join("plugins/model-router/index.js")),
        );
        assert_eq!(source.entry("absent"), None, "a plugin the directory omits is not provided");

        fs::remove_dir_all(&state).unwrap();
    }

    #[test]
    fn a_source_stays_inert_unless_reload_is_asked_for() {
        let state = scratch("inert");
        fs::create_dir_all(state.join("plugins/newpi-brand")).unwrap();
        fs::write(state.join("plugins/newpi-brand/index.js"), "// entry").unwrap();
        fs::write(state.join(DEV_FILENAME), "{\"pluginsDir\": \"plugins\"}").unwrap();

        let source = DevSource::read(&state).unwrap();
        assert_eq!(source.reload(), false, "restarting a live runtime is opt-in");

        fs::remove_dir_all(&state).unwrap();
    }

    #[test]
    fn the_fingerprint_moves_when_a_file_changes() {
        let state = scratch("fingerprint");
        fs::create_dir_all(state.join("plugins/model-router")).unwrap();
        let entry = state.join("plugins/model-router/index.js");
        fs::write(&entry, "// one").unwrap();
        fs::write(state.join("plugins/model-router/adaptive.js"), "// two").unwrap();
        fs::write(state.join(DEV_FILENAME), "{\"pluginsDir\": \"plugins\"}").unwrap();

        let source = DevSource::read(&state).unwrap();
        let before = source.fingerprint();
        assert_eq!(before, source.fingerprint(), "a still tree is a stable fingerprint");

        fs::write(&entry, "// one, but longer").unwrap();
        assert_ne!(before, source.fingerprint(), "a write is noticed");

        fs::write(state.join("plugins/model-router/plan.js"), "// three").unwrap();
        let added = source.fingerprint();
        assert_ne!(before, added, "a new file is noticed");

        // A non-JavaScript file is not part of the loop.
        fs::write(state.join("plugins/model-router/README.md"), "# notes").unwrap();
        assert_eq!(added, source.fingerprint(), "only JavaScript is watched");

        fs::remove_dir_all(&state).unwrap();
    }
}
