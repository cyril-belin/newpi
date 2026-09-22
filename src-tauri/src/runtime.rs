//! Supervision of the local engine runtime and its memory sidecar.
//!
//! NewPi never reimplements the harness. It locates the installed `dsh`
//! entry point, boots it in the `web` profile bound to loopback on a free
//! port, waits for the authenticated URL that the runtime prints once it can
//! serve the interface, then hands that URL to the window. On exit the whole
//! process tree is signalled as one group, so the persistent shells and
//! background jobs the harness started stop with it.
//!
//! It also owns the second child that memory needs: a PocketBase sidecar on
//! `127.0.0.1`, started before the harness so the harness can be configured
//! with its port, and stopped with it. The harness is told about it through a
//! generated `--patch` overlay and four environment variables, both built in
//! [`crate::memory`].
//!
//! Nothing here reaches a remote server. The only network traffic is the
//! model traffic the harness itself performs — and, on a machine that has never
//! run NewPi, the single verified download of the pinned PocketBase archive.
//!
//! Process management is deliberately free of Tauri types, so it can be
//! tested without a window. [`Supervisor::start`] is the thin adapter that
//! binds it to the application.

use std::collections::HashSet;
use std::ffi::OsString;
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::memory::{self, Layout};
use crate::pocketbase;
use crate::process::GroupChild;

/// Ports tried in order before letting the operating system assign one.
/// A stable port keeps the page origin stable, so the interface keeps its
/// local storage between launches.
const PREFERRED_PORTS: &[u16] = &[7317, 7318, 7319, 7320];

/// How long the runtime gets to become ready before the splash reports it.
const READY_TIMEOUT: Duration = Duration::from_secs(120);

/// The exact prefix the `web` profile prints once the interface is servable.
const READY_PREFIX: &str = "dsh web: ";

/// Event the splash listens to for supervisor state.
const EVENT_STATUS: &str = "newpi-status";

/// Event carrying raw runtime output, kept for a future log panel.
const EVENT_LOG: &str = "newpi-runtime-log";

/// Window label of the local boot screen declared in the configuration.
const SPLASH_LABEL: &str = "splash";

/// Window label of the window that carries the harness interface.
const MAIN_LABEL: &str = "main";

/// The harness profile NewPi boots, and the one whose installed plugins decide
/// whether Mem0 needs a disable row.
const PROFILE: &str = "web";

/// Environment variable that points the harness at an explicit directory.
const ENV_WORKSPACE: &str = "NEWPI_WORKSPACE";

/// The Project Model's registry document, below NewPi's state directory.
///
/// Repeated here rather than imported because it names a file the model writes
/// and the launcher reads; a test asserts the two spellings agree, so the name
/// cannot drift into a launch that silently ignores the user's last project.
const PROJECT_REGISTRY_FILENAME: &str = "projects.json";

/// Process group of the running runtime, published for the signal handler.
/// Zero means no runtime is running.
static RUNTIME_GROUP: AtomicI32 = AtomicI32::new(0);

/// Process group of the running memory sidecar, published for the same reason.
static SIDECAR_GROUP: AtomicI32 = AtomicI32::new(0);

/// Forward a termination signal to both children, then leave at once.
///
/// Only async signal safe calls are allowed here, so this reaches for `kill`
/// and `_exit` instead of the ordinary shutdown path.
extern "C" fn forward_termination(signal: libc::c_int) {
    for slot in [&RUNTIME_GROUP, &SIDECAR_GROUP] {
        let group = slot.load(Ordering::SeqCst);
        if group > 0 {
            unsafe {
                libc::kill(-group, libc::SIGTERM);
            }
        }
    }
    unsafe {
        libc::_exit(128 + signal);
    }
}

/// Stop the runtime when NewPi itself is asked to terminate, so a logout, a
/// `kill` or an interrupt never leaves an orphan harness behind. Tauri only
/// runs its own exit path for a window close or a quit from the menu, so
/// this covers the signals it does not see.
pub fn install_signal_handlers() {
    #[cfg(unix)]
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = forward_termination as *const () as usize;
        libc::sigemptyset(&mut action.sa_mask);
        action.sa_flags = 0;
        for signal in [libc::SIGTERM, libc::SIGINT] {
            libc::sigaction(signal, &action, std::ptr::null_mut());
        }
    }
}

/// One supervisor status message rendered by the splash.
#[derive(Clone, Serialize)]
pub struct StatusPayload {
    state: &'static str,
    title: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

impl StatusPayload {
    fn starting(detail: String) -> Self {
        Self {
            state: "starting",
            title: "Démarrage du runtime local".to_string(),
            message: "NewPi prépare son interface sur cette machine.".to_string(),
            detail: Some(detail),
        }
    }

    /// Progress while the memory sidecar is provisioned and started. It is a
    /// separate phase because it is the only part of the launch that can take
    /// seconds on a first run, and silence there looks like a hang.
    fn preparing_memory(detail: String) -> Self {
        Self {
            state: "starting",
            title: "Préparation de la mémoire du projet".to_string(),
            message: "NewPi démarre le stockage local des mémoires.".to_string(),
            detail: Some(detail),
        }
    }

    fn ready(url: &str) -> Self {
        Self {
            state: "ready",
            title: "Interface disponible".to_string(),
            message: "Ouverture de l'interface Harness.".to_string(),
            detail: Some(url.to_string()),
        }
    }

    fn failed(message: &str, detail: Option<String>) -> Self {
        Self {
            state: "error",
            title: "Le runtime n'a pas démarré".to_string(),
            message: message.to_string(),
            detail,
        }
    }
}

/// Everything the supervisor reports while it runs.
#[derive(Clone)]
pub enum RuntimeEvent {
    /// A state change worth showing on the splash.
    Status(StatusPayload),
    /// One line of runtime output.
    Log(String),
    /// The runtime serves the interface at this URL.
    Ready(String),
}

/// Where the harness entry point and its interpreter live.
struct RuntimeLocation {
    node: PathBuf,
    entry: PathBuf,
}

impl RuntimeLocation {
    /// Resolve the runtime in three passes, most self contained first.
    fn resolve(app: &AppHandle) -> Result<Self, String> {
        // 1. A runtime bundled inside the application wins, so a packaged
        //    NewPi keeps working on a machine with neither Node nor a global
        //    install of the harness.
        if let Ok(resources) = app.path().resource_dir() {
            let root = resources.join("runtime");
            let node = root.join("node/bin/node");
            let entry = root.join("dsh/lib/bin.js");
            if node.is_file() && entry.is_file() {
                return Ok(Self { node, entry });
            }
        }

        // 2. Explicit overrides, for development and troubleshooting.
        let node = match std::env::var_os("NEWPI_NODE") {
            Some(value) => PathBuf::from(value),
            None => search_executable("node").ok_or_else(|| {
                "Node.js est introuvable. Installez Node 20 ou une version plus récente, \
                 ou définissez NEWPI_NODE."
                    .to_string()
            })?,
        };

        let entry = match std::env::var_os("NEWPI_DSH_ENTRY") {
            Some(value) => PathBuf::from(value),
            None => {
                let launch = std::env::var_os("NEWPI_DSH_BIN")
                    .map(PathBuf::from)
                    .or_else(|| search_executable("dsh"))
                    .ok_or_else(|| {
                        "La commande dsh est introuvable. Installez le moteur NewPi, \
                         ou définissez NEWPI_DSH_ENTRY."
                            .to_string()
                    })?;
                // `dsh` on the path is normally a symbolic link into the
                // package, so follow it and run the real entry point.
                std::fs::canonicalize(&launch).unwrap_or(launch)
            }
        };

        if !node.is_file() {
            return Err(format!(
                "Interpréteur Node introuvable : {}",
                node.display()
            ));
        }
        if !entry.is_file() {
            return Err(format!(
                "Point d'entrée du harness introuvable : {}",
                entry.display()
            ));
        }
        Ok(Self { node, entry })
    }
}

/// Locate an executable on the path NewPi considers usable.
fn search_executable(name: &str) -> Option<PathBuf> {
    search_directories()
        .into_iter()
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}

/// Directories an application launched from Finder would otherwise miss,
/// because it never reads the user's shell profile.
fn search_directories() -> Vec<PathBuf> {
    let mut directories: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        directories.extend(std::env::split_paths(&path));
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        directories.push(home.join(".local/bin"));
        directories.push(home.join("bin"));
        directories.push(home.join(".cargo/bin"));
    }
    directories.push(PathBuf::from("/usr/local/bin"));
    directories.push(PathBuf::from("/opt/homebrew/bin"));
    directories.push(PathBuf::from("/usr/bin"));
    directories.push(PathBuf::from("/bin"));
    unique(directories)
}

fn unique(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

/// Path handed to the runtime, so the shells it starts find the same tools
/// the user has in a terminal.
fn runtime_path(node_directory: Option<&Path>) -> OsString {
    let mut directories: Vec<PathBuf> = Vec::new();
    if let Some(directory) = node_directory {
        directories.push(directory.to_path_buf());
    }
    directories.extend(search_directories());
    std::env::join_paths(unique(directories)).unwrap_or_default()
}

/// How one launch is scoped: where the harness runs, and which project, if
/// any, that launch belongs to.
///
/// The two are deliberately separate. The harness always needs a real working
/// directory, so a launch with no project still starts in the personal folder —
/// but that folder is a compatibility fallback, not a project, and nothing may
/// be attributed to it.
struct Launch {
    /// The directory the harness process starts in. Always a real directory.
    directory: PathBuf,
    /// The project that is open, when one is.
    project: Option<memory::Project>,
}

/// Resolve the launch scope.
///
/// The order, first success:
///
/// 1. `NEWPI_WORKSPACE`, the explicit override a person or a script sets. It is
///    a project by construction: the compatibility path for a launch that has
///    no Project Model record yet.
/// 2. the project the Project Model has open, read from its registry. The
///    harness is launched with exactly one working directory, so a project
///    chosen in the interface can only take effect on the *next* launch — which
///    means the choice has to be read here, before the runtime exists.
/// 3. no project. The harness starts in the personal folder so the launch still
///    works, but the folder carries no project scope and is never displayed as
///    one.
///
/// @param state - NewPi's application state directory.
/// @returns the directory and the open project, if any.
/// @throws when `NEWPI_WORKSPACE` names a project whose configuration cannot be
///   read; a launch that silently ignored it would be worse than a refusal.
fn resolve_launch(state: &Path) -> Result<Launch, String> {
    let explicit = std::env::var_os(ENV_WORKSPACE)
        .map(|value| expand_tilde(PathBuf::from(value)))
        .filter(|candidate| candidate.is_dir());
    launch_for(state, explicit)
}

/// The scoping decision itself, with the environment already read.
///
/// Split from {@link resolve_launch} so a test can exercise every branch
/// without mutating the process environment, which is shared and racy.
///
/// @param state - NewPi's application state directory.
/// @param explicit - the resolved `NEWPI_WORKSPACE`, when it named a directory.
/// @returns the directory and the open project, if any.
fn launch_for(state: &Path, explicit: Option<PathBuf>) -> Result<Launch, String> {
    if let Some(candidate) = explicit {
        let project = memory::Project::resolve(&candidate)?;
        return Ok(Launch {
            directory: candidate,
            project: Some(project),
        });
    }
    if let Some(project) = open_project(state) {
        return Ok(Launch {
            directory: project.root.clone(),
            project: Some(project),
        });
    }
    Ok(Launch {
        directory: home_dir(),
        project: None,
    })
}

/// The project the Project Model has open, read from its registry document.
///
/// The document belongs to the model; this reads the current project's record
/// and ignores everything else. Every way it can fail — no file, unreadable,
/// not JSON, no current project, a root that has since been moved or deleted —
/// is reported as "no project open", because the alternatives would be an
/// application that refuses to start over a stale entry, or one that invents a
/// project from whichever directory it happens to run in.
///
/// @param state - NewPi's application state directory.
/// @returns the open project, when the registry names one that still exists.
fn open_project(state: &Path) -> Option<memory::Project> {
    let text = std::fs::read_to_string(state.join(PROJECT_REGISTRY_FILENAME)).ok()?;
    let document: serde_json::Value = serde_json::from_str(&text).ok()?;
    let id = document.get("currentId")?.as_str()?;
    let record = document.get("projects")?.get(id)?;
    let root = PathBuf::from(record.get("rootPath")?.as_str()?);
    if !root.is_dir() {
        return None;
    }
    // A record written by an older build, or by hand, may omit the name and the
    // namespace. Both default to the id, which is the model's own rule.
    let name = record
        .get("name")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(id);
    let namespace = record
        .get("memoryNamespace")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(id);
    // Older NewPi builds synthesized this exact record from the process working
    // directory. Keep it in the registry so no user data is rewritten, but do
    // not let that historical fallback claim the personal folder as an open
    // project on every later launch.
    if root == home_dir()
        && id == memory::derived_id(&root)
        && name == memory::display_name(&root)
        && namespace == id
    {
        return None;
    }
    Some(memory::Project {
        id: id.to_string(),
        name: name.to_string(),
        namespace: namespace.to_string(),
        root,
        source: None,
    })
}

fn expand_tilde(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    let Some(rest) = text.strip_prefix("~/") else {
        return path;
    };
    match std::env::var_os("HOME") {
        Some(home) => PathBuf::from(home).join(rest),
        None => path,
    }
}

/// The user's home directory, as the environment reports it.
///
/// One of the roots the storage console measures and is fenced by. It is the
/// fallback `resolve_launch` uses for the process's working directory, kept as
/// its own function so the two can never disagree about where home is.
fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// First preferred port that is free, else 0 to let the operating system pick.
fn choose_port() -> u16 {
    for port in PREFERRED_PORTS {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", *port)) {
            drop(listener);
            return *port;
        }
    }
    0
}

/// The runtime prints `dsh web: <url>` once the interface can be served. A
/// deployment that also listens on the local network appends ` (LAN: <url>)`,
/// so only the first whitespace separated token is the loopback URL.
fn parse_ready_url(line: &str) -> Option<String> {
    let rest = line.trim().strip_prefix(READY_PREFIX)?;
    let url = rest.split_whitespace().next()?;
    if url.starts_with("http://") || url.starts_with("https://") {
        Some(url.to_string())
    } else {
        None
    }
}

/// Open the harness interface in its own window.
///
/// The token URL has to be this window's very first load. Navigating to it
/// from the local boot screen instead would make the redirect that follows a
/// cross site navigation, and the loopback session cookie is
/// `SameSite=Strict`, so the browser would withhold it and the runtime would
/// answer its "authentication required" page. A window created straight at
/// that URL has no such initiator, which is exactly how `dsh web` opens the
/// default browser successfully.
fn open_interface(app: &AppHandle, url: &str) {
    // The boot screen stays up until the interface has actually rendered.
    report(app, StatusPayload::ready(url));

    let parsed = match url.parse::<tauri::Url>() {
        Ok(parsed) => parsed,
        Err(error) => {
            report(
                app,
                StatusPayload::failed(
                    "L'adresse annoncée par le runtime est invalide.",
                    Some(format!("{url}\n{error}")),
                ),
            );
            return;
        }
    };

    let reveal_app = app.clone();
    let window = WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::External(parsed))
        .title("NewPi")
        .inner_size(1360.0, 900.0)
        .min_inner_size(880.0, 600.0)
        .center()
        .visible(false)
        .on_page_load(move |window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                reveal(&reveal_app, &window);
            }
        })
        .build();

    if let Err(error) = window {
        report(
            app,
            StatusPayload::failed(
                "La fenêtre n'a pas pu ouvrir l'interface Harness.",
                Some(error.to_string()),
            ),
        );
        return;
    }

    // A load signal that never arrives must not strand an invisible window.
    let fallback_app = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(10));
        if let Some(window) = fallback_app.get_webview_window(MAIN_LABEL) {
            reveal(&fallback_app, &window);
        }
    });
}

/// Show the interface and retire the boot screen. Repeating it is harmless.
fn reveal(app: &AppHandle, window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
    if let Some(splash) = app.get_webview_window(SPLASH_LABEL) {
        let _ = splash.close();
    }
}

fn report(app: &AppHandle, payload: StatusPayload) {
    let _ = app.emit(EVENT_STATUS, payload);
}

/// Everything the memory feature contributes to one launch.
///
/// Present only when the feature is enabled. The sidecar is owned here for the
/// lifetime of the supervisor, so it stops exactly when the runtime does.
struct MemorySetup {
    /// The generated `--patch` overlay the harness is started with.
    launcher_patch: PathBuf,
    /// Environment variables the plugins read: backend URL and credential.
    environment: Vec<(&'static str, String)>,
    /// One line describing the scope and the backend, for the launch log.
    summary: String,
    /// The running sidecar, or `None` when the sidecar could not start.
    sidecar: Option<GroupChild>,
    /// The loopback port the sidecar bound, or `0` when none was started.
    port: u16,
}

/// Owns the single runtime process for the lifetime of the application.
pub struct Supervisor {
    child: Child,
    process_group: i32,
    /// The memory sidecar, if this launch started one. Dropped with the
    /// supervisor, which stops it.
    sidecar: Option<GroupChild>,
}

impl Supervisor {
    /// Bind the supervisor to the application: resolve the runtime, prepare
    /// memory, then forward every event to the splash and navigate once ready.
    ///
    /// The development plugin source, when the state directory names one, is
    /// resolved here and returned with the supervisor: `main` needs it to decide
    /// whether to watch the tree, and resolving it once keeps the launch log
    /// honest about what was read.
    ///
    /// @param app - the running application.
    /// @returns the supervisor and the development source, when configured.
    pub fn start(app: &AppHandle) -> Result<(Self, Option<crate::dev::DevSource>), String> {
        let location = RuntimeLocation::resolve(app)?;
        // The state directory is resolved first because the project the user
        // has open lives in it, and that choice decides the launch scope.
        let state = state_directory(app)?;
        let launch = resolve_launch(&state)?;
        let port = choose_port();

        let dev = crate::dev::DevSource::read(&state);

        let (sender, receiver) = mpsc::channel();

        let memory = prepare_memory(app, &launch, &sender, dev.as_ref())?;

        let supervisor = Self::spawn(&location, &launch.directory, port, memory, sender)?;

        let forward_app = app.clone();
        thread::spawn(move || {
            while let Ok(event) = receiver.recv() {
                match event {
                    RuntimeEvent::Status(payload) => {
                        let _ = forward_app.emit(EVENT_STATUS, payload);
                    }
                    RuntimeEvent::Log(line) => {
                        let _ = forward_app.emit(EVENT_LOG, line);
                    }
                    RuntimeEvent::Ready(url) => open_interface(&forward_app, &url),
                }
            }
        });

        Ok((supervisor, dev))
    }

    /// Spawn the runtime in its own process group and report what it says.
    fn spawn(
        location: &RuntimeLocation,
        workspace: &Path,
        port: u16,
        memory: Option<MemorySetup>,
        report: Sender<RuntimeEvent>,
    ) -> Result<Self, String> {
        let _ = report.send(RuntimeEvent::Status(StatusPayload::starting(format!(
            "node      {}\nentrée    {}\nport      {}\nespace    {}\nmémoire   {}",
            location.node.display(),
            location.entry.display(),
            if port == 0 {
                "automatique".to_string()
            } else {
                port.to_string()
            },
            workspace.display(),
            match memory.as_ref() {
                Some(setup) => setup.summary.clone(),
                None => "désactivée".to_string(),
            },
        ))));

        let mut command = Command::new(&location.node);
        command.arg(&location.entry);

        // The launcher patch has to be a launcher level flag, before the app's
        // own arguments: `dsh web` rejects the parent's `--patch`, and a
        // `--patch` after the app name would be read by the web app instead.
        if let Some(setup) = memory.as_ref() {
            command
                .arg("--profile")
                .arg(PROFILE)
                .arg("--patch")
                .arg(&setup.launcher_patch);
        } else {
            command.arg("web");
        }

        command.arg("--no-open").arg("--port").arg(port.to_string());

        command
            .current_dir(workspace)
            .env("PATH", runtime_path(location.node.parent()))
            .env("DSH_HOME", dsh_home())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // The credential travels in the environment rather than in the patch
        // file: it keeps it out of a document the harness reads back and out of
        // the profile the user edits.
        if let Some(setup) = memory.as_ref() {
            for (key, value) in &setup.environment {
                command.env(key, value);
            }
        }

        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Give the runtime its own process group, so that everything it
            // starts can later be signalled as a single unit.
            command.process_group(0);
        }

        let child = command.spawn().map_err(|error| {
            format!("Impossible de lancer {} : {error}", location.node.display())
        })?;

        let process_group = i32::try_from(child.id()).unwrap_or(0);

        // Published before anything can signal us, so no orphan can survive.
        RUNTIME_GROUP.store(process_group, Ordering::SeqCst);

        let mut supervisor = Self {
            child,
            process_group,
            sidecar: memory.and_then(|setup| setup.sidecar),
        };

        let (Some(stdout), Some(stderr)) = (
            supervisor.child.stdout.take(),
            supervisor.child.stderr.take(),
        ) else {
            // A spawned child must never be abandoned, so a missing pipe tears
            // the runtime down before the failure is reported.
            supervisor.shutdown();
            return Err("Les flux du runtime sont indisponibles.".to_string());
        };

        let ready = Arc::new(AtomicBool::new(false));

        // Standard error is diagnostic traffic from the harness and its plugins.
        let log_sender = report.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[newpi/runtime] {line}");
                let _ = log_sender.send(RuntimeEvent::Log(line));
            }
        });

        // Standard output carries the readiness line that unblocks the window.
        let watch_sender = report.clone();
        let watch_ready = Arc::clone(&ready);
        thread::spawn(move || {
            let mut announced = false;
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                eprintln!("[newpi/runtime] {line}");

                if !announced {
                    if let Some(url) = parse_ready_url(&line) {
                        announced = true;
                        watch_ready.store(true, Ordering::SeqCst);
                        let _ = watch_sender.send(RuntimeEvent::Ready(url));
                        continue;
                    }
                }

                let _ = watch_sender.send(RuntimeEvent::Log(line));
            }

            if !announced {
                let _ = watch_sender.send(RuntimeEvent::Status(StatusPayload::failed(
                    "Le runtime s'est arrêté avant de servir l'interface.",
                    Some("La sortie complète du runtime se trouve dans la console.".to_string()),
                )));
            }
        });

        // A runtime that never becomes ready must not leave a silent splash.
        let timeout_sender = report;
        let timeout_ready = Arc::clone(&ready);
        thread::spawn(move || {
            let started = Instant::now();
            while started.elapsed() < READY_TIMEOUT {
                if timeout_ready.load(Ordering::SeqCst) {
                    return;
                }
                thread::sleep(Duration::from_millis(250));
            }
            let _ = timeout_sender.send(RuntimeEvent::Status(StatusPayload::failed(
                "Le runtime local n'a pas répondu dans le délai imparti.",
                Some(format!(
                    "Aucune ligne « {READY_PREFIX} » reçue en {} secondes.",
                    READY_TIMEOUT.as_secs()
                )),
            )));
        });

        Ok(supervisor)
    }

    /// Stop the runtime, the memory sidecar, and everything they started.
    pub fn shutdown(&mut self) {
        // From here on this code owns the termination, not the signal handler.
        RUNTIME_GROUP.store(0, Ordering::SeqCst);
        SIDECAR_GROUP.store(0, Ordering::SeqCst);

        if let Some(mut sidecar) = self.sidecar.take() {
            sidecar.shutdown();
        }

        crate::process::signal_group(self.process_group, libc::SIGTERM);

        let deadline = Instant::now() + crate::process::SHUTDOWN_GRACE;
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => thread::sleep(Duration::from_millis(100)),
                Err(_) => break,
            }
        }

        crate::process::signal_group(self.process_group, libc::SIGKILL);
        let _ = self.child.wait();
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        // Never leave an orphan runtime or sidecar behind, however the
        // application exits.
        if self.child.try_wait().ok().flatten().is_none() {
            self.shutdown();
        }
        if let Some(mut sidecar) = self.sidecar.take() {
            sidecar.shutdown();
        }
        RUNTIME_GROUP.store(0, Ordering::SeqCst);
        SIDECAR_GROUP.store(0, Ordering::SeqCst);
    }
}

/// Report a startup failure in the splash, which stays on screen so the
/// message remains readable.
///
/// The same message also goes to standard error. The splash is the only place
/// a user can see it, but a launch without a window — a terminal run, a log
/// capture, a bug report — would otherwise have no record of why the runtime
/// did not come up, and "the app did nothing" is the least useful failure there
/// is.
pub fn report_failure(app: &AppHandle, error: &str) {
    eprintln!("[newpi/runtime] démarrage impossible : {error}");
    let _ = app.emit(
        EVENT_STATUS,
        StatusPayload::failed(
            "Le runtime local n'a pas pu démarrer.",
            Some(error.to_string()),
        ),
    );
}

/// The application's own state directory, outside any bundle.
///
/// `~/Library/Application Support/NewPi` on macOS. It is the one place NewPi
/// writes: the extracted sidecar, its data, the generated credential, the
/// deployed plugins, and the launcher patch all live below it, so an
/// application update — which replaces the bundle — cannot touch them.
///
/// The directory is named for the product rather than for the bundle
/// identifier, which is what a user looking for their memories will search
/// for, and what the README documents. `app_data_dir` returns the platform's
/// per-application root (`~/Library/Application Support/<identifier>`); its
/// parent is the shared root NewPi wants, and using that directly also means
/// the path does not move if the bundle identifier ever does.
///
/// @param app - the running application, for the platform path resolver.
/// @returns the state directory, created if needed.
/// @throws a message naming the path when it cannot be created.
fn state_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let per_application = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Répertoire de données introuvable : {error}"))?;
    let root = per_application
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or(per_application);
    let directory = root.join("NewPi");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Création impossible de {} : {error}", directory.display()))?;
    Ok(directory)
}

/// The harness home: `$DSH_HOME` when set, `~/.dsh` otherwise.
///
/// NewPi sets it explicitly so the runtime — which a Finder launch starts
/// without the user's shell environment — always finds the same profile,
/// sessions, and settings a terminal `dsh` would.
fn dsh_home() -> PathBuf {
    if let Some(value) = std::env::var_os("DSH_HOME") {
        let path = expand_tilde(PathBuf::from(value));
        if !path.as_os_str().is_empty() {
            return path;
        }
    }
    std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".dsh"))
        .unwrap_or_else(|| PathBuf::from(".dsh"))
}

/// Prepare the memory sidecar and everything the harness needs to use it.
///
/// This is also where the model router's plan joins the launch: the two share
/// the state directory, the workspace, and the one launcher patch, and the
/// router needs no database, so it is attached whatever memory decided.
///
/// The order matters and is the whole point of this function:
///
/// 1. deploy the embedded plugins and migration, so no file is stale;
/// 2. ensure the verified sidecar executable exists;
/// 3. resolve the project scope from the workspace;
/// 4. start the sidecar on a free loopback port and create its credential;
/// 5. write the launcher patch naming that port, and the environment the
///    plugins read.
///
/// A failure at any step disables memory for this launch. NewPi's job is to
/// show a window; losing a memory backend must cost the user `recall`, not the
/// application. Every failure is reported through the splash so it is never
/// silent.
///
/// # What survives a missing sidecar
///
/// Without a sidecar there is nothing to talk to, so the three memory rows are
/// dropped — [`without_memory`] does it. Loading a plugin whose every call would
/// fail helps nobody, and `memory-console` injects the backend service, so
/// mounting it alone would leave its fiber waiting for a service that never
/// arrives — which the loader treats as a failed *launch*, not a failed
/// feature. The rows that stay are the three that have no database behind them:
/// the product name, the file console, and the storage console.
///
/// @param app - the running application, for the splash channel and paths.
/// @param launch - the resolved launch: the directory the harness runs in and
///   the open project, when one is.
/// @param report - the supervisor's event channel.
/// @param dev - the development plugin source, when the state directory names
///   one: its plugins are mounted from the repository and are not deployed.
/// @returns the setup. `NEWPI_MEMORY=0` still returns one: the plugins that are
///   not memory are mounted either way, and `sidecar` is `None`.
fn prepare_memory(
    app: &AppHandle,
    launch: &Launch,
    report: &Sender<RuntimeEvent>,
    dev: Option<&crate::dev::DevSource>,
) -> Result<Option<MemorySetup>, String> {
    // `NEWPI_MEMORY=0` turns the memory feature off for one launch. It does not
    // turn NewPi off: the plugins that are not the memory feature — the product
    // name, the file console, the storage console — are still deployed and
    // still mounted, because none of them needs a database. Only the sidecar,
    // its credential and the three memory rows are skipped.
    let memory_enabled = memory::enabled();
    if !memory_enabled {
        eprintln!("[newpi/memory] désactivée par {}", memory::ENV_ENABLED);
    }

    let state = state_directory(app)?;
    let layout = Layout::new(&state);

    let _ = report.send(RuntimeEvent::Status(StatusPayload::preparing_memory(
        format!("données    {}", state.display()),
    )));

    // `project` is the single source of truth every project-scoped row is keyed
    // by. The launch directory is deliberately not read here: when no project is
    // open it is the personal folder, a compatibility fallback that must never
    // be mistaken for a project.
    let project = launch.project.as_ref();

    let mut setup = MemorySetup {
        launcher_patch: layout.launcher_patch.clone(),
        environment: Vec::new(),
        summary: String::new(),
        sidecar: None,
        port: 0,
    };

    // 1. The embedded plugins and migration, plus the module tree their
    //    bare specifiers resolve against.
    layout.create()?;
    let (written, removed) = memory::deploy_assets(&layout, dev)?;
    if written > 0 || removed > 0 {
        eprintln!("[newpi/memory] {written} fichier(s) déployé(s), {removed} supprimé(s)");
    }
    match memory::link_module_tree(&layout, &dsh_home()) {
        Some(tree) => eprintln!("[newpi/memory] modules du harness : {}", tree.display()),
        None => eprintln!(
            "[newpi/memory] aucun arbre de modules : les plugins ne pourront pas résoudre @deepseek-ai/cordis"
        ),
    }

    // 2, 3, 4. The sidecar: its verified executable, its credential, and the
    //    process itself. All three are skipped when memory is off for this
    //    launch, and a credential that is never used is never generated.
    let credential = if memory_enabled {
        let extracted = pocketbase::ensure_executable(&layout)?;
        if extracted {
            eprintln!(
                "[newpi/memory] PocketBase {} extrait et vérifié",
                pocketbase::VERSION
            );
        }

        let credential = pocketbase::credential(&layout.credentials)?;

        let mut port = 0;
        match pocketbase::start(&layout) {
            Ok((child, bound)) => {
                SIDECAR_GROUP.store(child.group(), Ordering::SeqCst);
                setup.sidecar = Some(child);
                port = bound;
            }
            Err(error) => {
                // A sidecar that will not start is reported and stepped over:
                // the plugins load anyway and answer every memory call with the
                // transport failure, which is a far better outcome than no
                // window.
                eprintln!("[newpi/memory] sidecar indisponible : {error}");
                let _ = report.send(RuntimeEvent::Log(format!(
                    "newpi/memory: PocketBase indisponible ({error})"
                )));
            }
        }
        setup.port = port;
        Some(credential)
    } else {
        None
    };

    // 5. The launcher patch and the environment.
    let mem0 = memory::mem0_installed(&dsh_home(), PROFILE);
    // The storage console's `workspace` root is the open project's, never the
    // directory the harness happens to run in: with no project it is empty, and
    // no project target hangs from the personal folder.
    let project_root = project.map(|project| project.root.as_path());
    let roots = memory::Roots::new(
        project_root.unwrap_or_else(|| Path::new("")),
        &home_dir(),
        &dsh_home(),
    );

    // 5a. The model router, when the project declares a plan. A plan that does
    //     not validate is reported and left out: an unusable routing policy must
    //     cost the user the router, not the window, and mounting a router on a
    //     guess would be worse than mounting none. With no project open there is
    //     no plan to resolve: the personal folder is not a project and a
    //     `cordis.yml` left there is not this launch's policy.
    let plan_row = match project {
        Some(project) => match crate::models::Plan::resolve(&project.root) {
            Ok(Some(plan)) => match plan.row(&layout) {
                Ok(row) => {
                    eprintln!("[newpi/models] plan de routage : mode={:?}", plan.mode);
                    Some(row)
                }
                Err(error) => {
                    eprintln!("[newpi/models] {error}");
                    let _ = report.send(RuntimeEvent::Log(format!("newpi/models: {error}")));
                    None
                }
            },
            Ok(None) => None,
            Err(error) => {
                let source = crate::models::project_config(&project.root);
                eprintln!("[newpi/models] {}", error);
                let _ = report.send(RuntimeEvent::Log(format!(
                    "newpi/models: modèle non routé — {error} ({})",
                    source.display(),
                )));
                None
            }
        },
        None => None,
    };

    let rows = launcher_rows(
        &layout,
        project,
        &roots,
        mem0,
        setup.sidecar.is_some(),
        plan_row,
        dev,
    );
    crate::patch::write(&state, &rows)?;
    // The environment — and the superuser the harness authenticates with — only
    // exist when there is a sidecar to talk to. A patch of non-memory rows is
    // not a reason to open the memory database.
    if let (Some(credential), Some(_)) = (&credential, &setup.sidecar) {
        pocketbase::provision_superuser(&layout, credential)?;
        setup.environment = vec![
            (memory::ENV_URL, format!("http://127.0.0.1:{}", setup.port)),
            (memory::ENV_IDENTITY, credential.identity.clone()),
            (memory::ENV_PASSWORD, credential.password.clone()),
        ];
        // The project scope enters the harness only when a project is open. With
        // none, the variable is absent rather than a directory-derived guess, so
        // the memory backend refuses every call instead of writing a personal
        // namespace nobody asked for.
        if let Some(project) = project {
            setup
                .environment
                .push((memory::ENV_PROJECT_ID, project.namespace.clone()));
        }
    }

    setup.summary = match (setup.sidecar.as_ref(), project) {
        (Some(_), Some(project)) => format!(
            "{} · port {}{}",
            project.name,
            setup.port,
            project
                .source
                .as_ref()
                .map(|path| format!(" · {}", path.display()))
                .unwrap_or_default(),
        ),
        (Some(_), None) => format!("aucun projet ouvert · port {}", setup.port),
        (None, Some(project)) => format!(
            "{} · projet {}",
            if memory_enabled {
                "indisponible"
            } else {
                "désactivée"
            },
            project.id,
        ),
        (None, None) => format!(
            "{} · aucun projet ouvert",
            if memory_enabled {
                "indisponible"
            } else {
                "désactivée"
            },
        ),
    };

    if mem0 {
        eprintln!(
            "[newpi/memory] Mem0 est présent dans le profil {PROFILE} ; il est désactivé par le patch de lancement (aucune suppression)"
        );
    }
    eprintln!(
        "[newpi/memory] projet={} port={} base={}",
        project.map(|project| project.id.as_str()).unwrap_or("(aucun)"),
        setup.port,
        layout.data.display(),
    );

    Ok(Some(setup))
}

/// The rows that stay when no sidecar came up.
///
/// A pure function of the row list, so the decision is testable without
/// spawning anything. The survivors are exactly the plugins that inject no
/// `pocketbaseMemory`: the product name, the project model, the storage
/// console, and the context and cache manager. Everything else is dropped,
/// including `memory-console`, which injects the backend and would otherwise
/// wait forever for a service that never arrives.
///
/// @param rows - the full row list for this launch.
/// @returns the rows to write into the launcher patch.
fn without_memory(rows: Vec<crate::patch::Row>) -> Vec<crate::patch::Row> {
    rows.into_iter()
        .filter(|row| {
            row.id == "newpi-brand"
                || row.id == "session-queue-guard"
                || row.id == "project-model"
                || row.id == "projects-console"
                || row.id == "storage-console"
                || row.id == "context-cache-manager"
        })
        .collect()
}

/// The plugin rows one launch mounts, in order.
///
/// Memory's rows depend on whether a sidecar came up; the router's row does
/// not, and is appended after that decision rather than among them. Keeping the
/// composition in one pure function is what lets a test prove that ordering:
/// the router must survive a launch with no database, because routing a model
/// call has nothing to do with one.
///
/// @param layout - the resolved layout.
/// @param project - the open project scope, or `None` when none is open.
/// @param roots - the roots the storage console is fenced by.
/// @param mem0 - whether the profile declares Mem0.
/// @param sidecar - whether the memory sidecar is running this launch.
/// @param router - the model router's row, when the project declared a plan.
/// @param dev - the development plugin source, when one is configured.
/// @returns the rows to write into the launcher patch.
fn launcher_rows(
    layout: &memory::Layout,
    project: Option<&memory::Project>,
    roots: &memory::Roots,
    mem0: bool,
    sidecar: bool,
    router: Option<crate::patch::Row>,
    dev: Option<&crate::dev::DevSource>,
) -> Vec<crate::patch::Row> {
    let memory_rows = memory::rows(layout, project, roots, mem0, dev);
    let mut rows = if sidecar {
        memory_rows
    } else {
        without_memory(memory_rows)
    };
    rows.extend(router);
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The model router is not a memory feature: it is mounted whatever the
    /// sidecar decided, and it is the last row so nothing filters it.
    #[test]
    fn the_model_router_survives_a_launch_without_a_sidecar() {
        let layout = crate::memory::Layout::new(Path::new("/state"));
        let project = crate::memory::Project {
            id: "twin".to_string(),
            name: "twin".to_string(),
            namespace: "twin".to_string(),
            root: PathBuf::from("/workspace"),
            source: None,
        };
        let roots = crate::memory::Roots::new(
            Path::new("/workspace"),
            Path::new("/home"),
            Path::new("/home/.dsh"),
        );
        let plan = crate::models::Plan::parse(
            "model_router:\n  mode: manual\n  manual:\n    provider: alpha\n    model: m1\n",
        )
        .unwrap()
        .unwrap();
        let row = plan.row(&layout).unwrap();

        let without = launcher_rows(
            &layout,
            Some(&project),
            &roots,
            true,
            false,
            Some(row.clone()),
            None,
        );
        assert_eq!(without.last().unwrap().id, "model-router");
        assert!(!without.iter().any(|row| row.id == "pocketbase-memory"));
        assert!(without.iter().any(|row| row.id == "storage-console"));

        let with = launcher_rows(&layout, Some(&project), &roots, true, true, Some(row), None);
        assert_eq!(with.last().unwrap().id, "model-router");
        assert!(with.iter().any(|row| row.id == "pocketbase-memory"));
    }

    #[test]
    fn without_a_sidecar_only_the_rows_that_need_no_database_survive() {
        let layout = crate::memory::Layout::new(Path::new("/state"));
        let project = crate::memory::Project {
            id: "twin".to_string(),
            name: "twin".to_string(),
            namespace: "twin".to_string(),
            root: PathBuf::from("/workspace"),
            source: None,
        };
        let roots = crate::memory::Roots::new(
            Path::new("/workspace"),
            Path::new("/home"),
            Path::new("/home/.dsh"),
        );
        let rows = crate::memory::rows(&layout, Some(&project), &roots, true, None);
        let kept: Vec<String> = without_memory(rows).into_iter().map(|row| row.id).collect();
        assert_eq!(
            kept,
            vec![
                "newpi-brand",
                "session-queue-guard",
                "project-model",
                "projects-console",
                "storage-console",
                "context-cache-manager"
            ]
        );
    }

    /// With no project open the launch still gets a real working directory — the
    /// personal folder — but it is not a project: no id, no name and no memory
    /// namespace are claimed, so nothing can be attributed to it. Before this,
    /// the folder's name became the namespace and the interface showed the
    /// personal folder as a project.
    #[test]
    fn a_launch_with_no_open_project_claims_no_project() {
        let state = test_dir("no-open-project");
        std::fs::write(
            state.join(PROJECT_REGISTRY_FILENAME),
            "{\"version\":1,\"currentId\":null,\"recent\":[],\"projects\":{}}",
        )
        .unwrap();

        let launch = launch_for(&state, None).unwrap();
        assert!(
            launch.project.is_none(),
            "the personal folder must never become a project",
        );
        assert_eq!(launch.directory, home_dir());
        assert!(launch.directory.is_dir(), "the launch still needs a directory");
    }

    /// A legacy registry can still contain the personal-directory record an
    /// older launcher fabricated. It stays on disk for compatibility, but it
    /// cannot become an open project, a memory namespace, or Storage's root.
    #[test]
    fn a_legacy_personal_directory_record_is_not_an_open_project() {
        let state = test_dir("legacy-personal-directory");
        let home = home_dir();
        let id = crate::memory::derived_id(&home);
        let name = crate::memory::display_name(&home);
        std::fs::write(
            state.join(PROJECT_REGISTRY_FILENAME),
            serde_json::json!({
                "version": 1,
                "currentId": id.clone(),
                "recent": [id.clone()],
                "projects": {
                    id.clone(): {
                        "id": id,
                        "name": name,
                        "memoryNamespace": id,
                        "rootPath": home,
                    }
                }
            })
            .to_string(),
        )
        .unwrap();

        let launch = launch_for(&state, None).unwrap();
        assert!(launch.project.is_none());
        assert_eq!(launch.directory, home_dir());
        assert!(open_project(&state).is_none());
    }

    /// The Project Model's own record is the source of truth. The launcher must
    /// take the human name and the memory namespace from it rather than deriving
    /// them from the directory name: when the two disagreed, the same project got
    /// a second identity and its memory was split in two.
    #[test]
    fn an_open_project_carries_its_name_and_namespace_from_the_registry() {
        let state = test_dir("open-project");
        let root = state.join("my-app");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            state.join(PROJECT_REGISTRY_FILENAME),
            format!(
                "{{\"version\":1,\"currentId\":\"custom\",\"recent\":[\"custom\"],\
                  \"projects\":{{\"custom\":{{\"id\":\"custom\",\"name\":\"My App\",\
                  \"memoryNamespace\":\"my-app-memory\",\"rootPath\":{}}}}}}}",
                serde_json::Value::String(root.display().to_string()),
            ),
        )
        .unwrap();

        let launch = launch_for(&state, None).unwrap();
        assert_eq!(launch.directory, root);
        let project = launch.project.expect("the registry named an open project");
        assert_eq!(project.id, "custom");
        assert_eq!(project.name, "My App");
        assert_eq!(project.namespace, "my-app-memory");
        assert_eq!(project.root, root);
    }

    /// `NEWPI_WORKSPACE` is the compatibility path: an explicit directory is a
    /// project by construction, even before the Project Model knows it, and its
    /// derived id is exactly what a launch without the registry always used.
    #[test]
    fn an_explicit_workspace_is_a_project_even_without_a_registry() {
        let state = test_dir("explicit-workspace");
        let root = state.join("twin");
        std::fs::create_dir_all(&root).unwrap();

        let launch = launch_for(&state, Some(root.clone())).unwrap();
        assert_eq!(launch.directory, root);
        let project = launch.project.expect("an explicit workspace is a project");
        assert_eq!(project.id, "twin");
        assert_eq!(project.name, "twin");
        assert_eq!(project.namespace, "twin");
        assert_eq!(project.root, root);
    }

    /// A registry that is missing, corrupt, or points at a directory that has
    /// since moved must cost the user their open project, never the launch —
    /// and, just as important, must never fall back to inventing one.
    #[test]
    fn a_registry_that_cannot_be_used_yields_no_project() {
        let state = test_dir("last-project-unusable");
        assert!(open_project(&state).is_none(), "a missing registry");

        std::fs::write(state.join(PROJECT_REGISTRY_FILENAME), "not json").unwrap();
        assert!(open_project(&state).is_none(), "a corrupt registry");

        std::fs::write(
            state.join(PROJECT_REGISTRY_FILENAME),
            "{\"version\":1,\"currentId\":\"gone\",\"recent\":[],\"projects\":\
              {\"gone\":{\"id\":\"gone\",\"rootPath\":\"/no/such/directory/anywhere\"}}}",
        )
        .unwrap();
        assert!(open_project(&state).is_none(), "a moved project");

        std::fs::write(
            state.join(PROJECT_REGISTRY_FILENAME),
            "{\"version\":1,\"currentId\":null,\"recent\":[],\"projects\":{}}",
        )
        .unwrap();
        assert!(open_project(&state).is_none(), "no current project");
        assert!(
            launch_for(&state, None).unwrap().project.is_none(),
            "an unusable registry must not fall back to a project",
        );
    }

    /// The launcher reads a file the Project Model writes; a rename on either
    /// side would silently stop the last project from being reopened.
    #[test]
    fn the_registry_filename_matches_the_project_model() {
        let source = include_str!("../../plugins/project-model/store.js");
        assert!(
            source.contains(&format!(
                "REGISTRY_FILENAME = '{PROJECT_REGISTRY_FILENAME}'"
            )),
            "the launcher and the Project Model disagree about the registry file name",
        );
    }

    /// A scratch directory under `target/`, emptied first so two runs cannot
    /// read each other's registry.
    fn test_dir(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/test-tmp")
            .join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_the_loopback_url_from_the_ready_line() {
        let line = "dsh web: http://127.0.0.1:7317/?token=abc123";
        assert_eq!(
            parse_ready_url(line).as_deref(),
            Some("http://127.0.0.1:7317/?token=abc123"),
        );
    }

    #[test]
    fn ignores_the_local_network_suffix() {
        let line =
            "dsh web: http://127.0.0.1:7317/?token=abc (LAN: http://10.0.0.4:7317/?token=abc)";
        assert_eq!(
            parse_ready_url(line).as_deref(),
            Some("http://127.0.0.1:7317/?token=abc"),
        );
    }

    #[test]
    fn ignores_unrelated_output() {
        assert_eq!(parse_ready_url("dsh plugin: installing"), None);
        assert_eq!(parse_ready_url("dsh web: not-a-url"), None);
    }

    #[test]
    fn prefers_a_free_port() {
        let port = choose_port();
        assert!(port == 0 || PREFERRED_PORTS.contains(&port));
    }

    /// The point of the process group: a runtime that starts helpers of its
    /// own must not leave them behind when NewPi closes.
    #[test]
    fn shutdown_stops_the_whole_process_group() {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/test-tmp/fake-dsh.sh");
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        // A stand in for the harness: one long lived helper of its own, then
        // the readiness line the supervisor waits for.
        std::fs::write(
            &script,
            "#!/bin/sh\nsleep 300 &\necho 'dsh web: http://127.0.0.1:1/?token=test'\nwait\n",
        )
        .unwrap();

        let location = RuntimeLocation {
            node: PathBuf::from("/bin/sh"),
            entry: script,
        };

        let (sender, receiver) = mpsc::channel();
        let mut supervisor =
            Supervisor::spawn(&location, Path::new("/tmp"), 0, None, sender).unwrap();
        let group = supervisor.process_group;

        let ready = receiver
            .iter()
            .take(20)
            .any(|event| matches!(event, RuntimeEvent::Ready(_)));
        assert!(ready, "the fake runtime never reported readiness");

        // The helper is alive while the runtime runs.
        assert!(group_is_alive(group), "the runtime group died too early");

        supervisor.shutdown();

        let deadline = Instant::now() + Duration::from_secs(5);
        while group_is_alive(group) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        assert!(
            !group_is_alive(group),
            "a process from the runtime group outlived shutdown",
        );
    }

    /// True while at least one process remains in the group.
    fn group_is_alive(group: i32) -> bool {
        #[cfg(unix)]
        unsafe {
            libc::kill(-group, 0) == 0
        }
        #[cfg(not(unix))]
        {
            let _ = group;
            false
        }
    }
}
