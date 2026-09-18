//! The launcher patch: how NewPi turns its own facts into harness configuration.
//!
//! The harness composes a profile from ordered patch layers, and `--patch`
//! overlays are the last layer before the telemetry switch. NewPi uses exactly
//! one overlay, regenerated on every launch, to mount its own plugins with the
//! coordinates that belong to this launch and this project:
//!
//! - the sidecar's loopback URL, port included, which changes every launch;
//! - the project scope, read from the project's own `cordis.yml`;
//! - the model router's plan, read from that same document when it declares one;
//! - a non-destructive `disabled` row for any memory plugin the user has
//!   installed and wants off.
//!
//! The credential is deliberately *not* in this file. It travels in the
//! harness's environment (`DSH_MEMORY_PASSWORD`), which keeps it out of a
//! document the harness reads back, and out of the profile the user edits.
//!
//! The generator writes YAML by hand. The document is five keys deep at most,
//! and a serializer dependency would be a larger surface than the twenty lines
//! it replaces — but string values still go through a proper quoting function,
//! because a project identifier is user input and a Windows path is not a
//! scalar.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// One row of a patch layer.
#[derive(Debug, Clone, Default)]
pub struct Row {
    /// Stable row id, also the file name of the deployed plugin.
    pub id: String,
    /// Module specifier the loader imports: a `file://` URL for our plugins.
    pub name: String,
    /// Whether the row is mounted at all.
    pub disabled: bool,
    /// Configuration keys, emitted in sorted order for a stable file.
    pub config: BTreeMap<String, String>,
}

impl Row {
    /// A row for one of NewPi's own plugin files.
    ///
    /// @param id - the row id and plugin directory name.
    /// @param entry - absolute path of the plugin's `index.js`.
    /// @returns the row, enabled and without configuration.
    pub fn plugin(id: &str, entry: &Path) -> Self {
        Self {
            id: id.to_string(),
            name: file_url(entry),
            disabled: false,
            config: BTreeMap::new(),
        }
    }

    /// A row that turns an installed package off without uninstalling it.
    ///
    /// This is the non-destructive disable: the package stays in the profile,
    /// its files stay on disk, and removing this row restores it. It is why
    /// reverting Mem0 is a one line change rather than a reinstall.
    ///
    /// @param id - the package's row id in the profile composition.
    /// @param package - the package specifier, recorded so the row is readable.
    /// @returns the disabled row.
    pub fn disabled_package(id: &str, package: &str) -> Self {
        Self {
            id: id.to_string(),
            name: package.to_string(),
            disabled: true,
            config: BTreeMap::new(),
        }
    }

    /// Add one configuration entry.
    ///
    /// @param key - the configuration key.
    /// @param value - the value, quoted on output.
    /// @returns the row, for chaining.
    pub fn with_config(mut self, key: &str, value: impl Into<String>) -> Self {
        self.config.insert(key.to_string(), value.into());
        self
    }
}

/// Turn an absolute path into a `file://` URL the loader can import.
///
/// The loader resolves a specifier that starts with `.` against the profile
/// directory, and anything else as a bare module specifier — so an absolute
/// path only works as a URL. `url::Url::from_file_path` percent-encodes the
/// characters a path may legally contain and a URL may not.
///
/// @param path - an absolute path.
/// @returns the URL, or the lossy path if it cannot be expressed as one.
pub fn file_url(path: &Path) -> String {
    match tauri::Url::from_file_path(path) {
        Ok(url) => url.to_string(),
        Err(()) => format!("file://{}", path.display()),
    }
}

/// Render one patch layer.
///
/// @param rows - the rows to insert, in order.
/// @returns the YAML document, newline terminated.
pub fn render(rows: &[Row]) -> String {
    let mut out = String::from(
        "# NewPi launcher patch — generated at every launch, do not edit.\n\
         #\n\
         # This file is the last overlay in the profile composition, so it wins\n\
         # over the profile's own cordis.patch.yml. It mounts NewPi's own\n\
         # plugins — the memory feature, the consoles, the model router — and\n\
         # nothing else. Delete it and nothing changes: the next launch writes\n\
         # it again from the application's own state.\n\
         - insert:\n",
    );

    for row in rows {
        out.push_str(&format!("    - id: {}\n", scalar(&row.id)));
        out.push_str(&format!("      name: {}\n", scalar(&row.name)));
        if row.disabled {
            out.push_str("      disabled: true\n");
        }
        if !row.config.is_empty() {
            out.push_str("      config:\n");
            for (key, value) in &row.config {
                out.push_str(&format!("        {key}: {}\n", scalar(value)));
            }
        }
    }

    out
}

/// Quote a YAML scalar so that no value can change the document's structure.
///
/// Single quotes are YAML's literal style: the only escape is a doubled quote,
/// so colons, `#`, and leading indicators are all inert inside them. Every value
/// NewPi emits is a string, so quoting all of them unconditionally is both
/// correct and the simplest rule to keep correct.
///
/// Line breaks are the one character single quotes do *not* neutralize — a
/// literal newline inside a quoted scalar is still a line break, and a line
/// break at the wrong indentation starts a new node. Values are therefore
/// flattened to spaces, which is lossless for every value NewPi produces (a
/// row id, a module URL, a project identifier) and fails safe for one it did
/// not expect.
///
/// @param value - the raw value.
/// @returns the quoted, single line scalar.
fn scalar(value: &str) -> String {
    let flattened = value.replace(['\n', '\r'], " ");
    format!("'{}'", flattened.replace('\'', "''"))
}

/// The file name the launcher patch is written to, inside the state directory.
pub const LAUNCHER_PATCH_FILENAME: &str = "launcher.patch.yml";

/// Write the launcher patch into `directory`, replacing any previous one.
///
/// The write goes through a temporary file in the same directory because the
/// harness watches profile files: a reader must never observe a half written
/// document.
///
/// @param directory - the application's state directory.
/// @param rows - the rows to insert.
/// @returns the path of the written file.
/// @throws a message naming the path when the write fails.
pub fn write(directory: &Path, rows: &[Row]) -> Result<PathBuf, String> {
    let path = directory.join(LAUNCHER_PATCH_FILENAME);
    let temporary = directory.join(format!("{LAUNCHER_PATCH_FILENAME}.tmp"));
    std::fs::write(&temporary, render(rows))
        .map_err(|error| format!("Écriture impossible de {} : {error}", temporary.display()))?;
    std::fs::rename(&temporary, &path)
        .map_err(|error| format!("Installation impossible de {} : {error}", path.display()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_a_value_that_would_otherwise_change_the_document() {
        // A project id is user input, so it must not be able to inject a row.
        // The value is both flattened and quoted: the injected line cannot
        // become a list item, and the quote cannot close the scalar.
        let row = Row::plugin(
            "memory-tools",
            Path::new("/tmp/plugins/memory-tools/index.js"),
        )
        .with_config("projectId", "it's a trap\n- insert:");
        let text = render(&[row]);
        assert!(text.contains("projectId: 'it''s a trap - insert:'"));
        // Only the document's own header introduces a top level list.
        assert_eq!(text.matches("\n- insert:").count(), 1);
        // And no value introduced a nested list item of its own.
        assert_eq!(text.matches("    - id:").count(), 1);
    }

    #[test]
    fn renders_a_disabled_row_without_config() {
        let text = render(&[Row::disabled_package("mem0", "@scope/mem0")]);
        assert!(text.contains("    - id: 'mem0'\n"));
        assert!(text.contains("      name: '@scope/mem0'\n"));
        assert!(text.contains("      disabled: true\n"));
        assert!(!text.contains("config:"));
    }

    #[test]
    fn renders_rows_in_order_with_sorted_config() {
        let first = Row::plugin("alpha-plugin", Path::new("/tmp/a.js"))
            .with_config("zeta", "1")
            .with_config("alpha", "2");
        let second = Row::plugin("beta-plugin", Path::new("/tmp/b.js"));
        let text = render(&[first, second]);
        let alpha = text.find("config:").unwrap();
        assert!(
            text[alpha..].find("alpha: '2'").unwrap() < text[alpha..].find("zeta: '1'").unwrap(),
            "config keys must be emitted in sorted order",
        );
        assert!(
            text.find("- id: 'alpha-plugin'").unwrap() < text.find("- id: 'beta-plugin'").unwrap()
        );
    }

    /// Write one rendered patch to a known path so the Node test suite can
    /// parse it with the same YAML reader the harness uses. The Rust tests
    /// prove the text is what this module intends; only a real YAML parser can
    /// prove the harness will read it back as the same document.
    ///
    /// It carries a model-router row too, so the contract between the Rust plan
    /// and the plugin that reads it is checked by the same parser the harness
    /// uses — a JSON scalar inside a YAML scalar is exactly the kind of thing a
    /// hand-written generator can get wrong while its own tests pass.
    #[test]
    fn dumps_a_sample_patch_for_the_javascript_test_suite() {
        let layout = crate::memory::Layout::new(Path::new("/state"));
        let project = crate::memory::Project {
            id: "twin".to_string(),
            source: None,
        };
        let roots = crate::memory::Roots::new(
            Path::new("/workspace"),
            Path::new("/home"),
            Path::new("/home/.dsh"),
        );
        let mut rows = crate::memory::rows(&layout, &project, &roots, true, None);
        let plan = crate::models::Plan::parse(
            "model_router:\n  mode: auto\n  roles:\n    coding:\n      provider: alpha\n      model: big\n      reasoning: high\n      fallback:\n        provider: beta\n        model: other\n    default:\n      provider: alpha\n      model: mid\n  requirements:\n    coding:\n      tools: true\n      max_context: 64000\n",
        )
        .unwrap()
        .unwrap();
        rows.push(plan.row(&layout).unwrap());
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/test-tmp");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("launcher-sample.patch.yml"), render(&rows)).unwrap();
    }

    #[test]
    fn turns_an_absolute_path_into_a_file_url() {
        let url = file_url(Path::new("/tmp/a b/index.js"));
        assert!(url.starts_with("file:///tmp/"));
        assert!(url.contains("a%20b"), "spaces must be encoded: {url}");
    }
}
