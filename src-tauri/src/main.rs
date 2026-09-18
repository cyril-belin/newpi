//! NewPi, a native macOS desktop application.
//!
//! The window starts on a local splash, then navigates to the interface the
//! local harness runtime serves over loopback. The runtime is started when
//! the app starts and stopped when the app exits.
//!
//! NewPi also owns the durable project memory that survives those sessions: a
//! local PocketBase sidecar, the Cordis plugins that expose it to the agent,
//! and the configuration that scopes it to one project. See [`memory`] for the
//! on-disk layout and [`pocketbase`] for the sidecar's lifecycle.

mod assets;
mod dev;
mod memory;
mod models;
mod patch;
mod pocketbase;
mod process;
mod runtime;

use std::sync::Mutex;

use tauri::{Manager, RunEvent};

use runtime::Supervisor;

/// Application state: the one runtime process this window owns.
#[derive(Default)]
struct NewPi {
    supervisor: Mutex<Option<Supervisor>>,
}

impl NewPi {
    /// Take ownership of a freshly started runtime.
    fn adopt(&self, supervisor: Supervisor) {
        if let Ok(mut guard) = self.supervisor.lock() {
            *guard = Some(supervisor);
        }
    }

    /// Stop the runtime and forget it. Safe to call more than once.
    fn stop_runtime(&self) {
        if let Ok(mut guard) = self.supervisor.lock() {
            if let Some(mut supervisor) = guard.take() {
                supervisor.shutdown();
            }
        }
    }

    /// Stop the runtime and start a fresh one, then let the window follow it.
    ///
    /// This is what the development loop asks for, and it is the restart a
    /// person gets by quitting and reopening the application: the runtime comes
    /// up on a fresh port and [`runtime::Supervisor::start`] navigates the
    /// existing window to its new token URL, so a changed plugin file is what
    /// the next interaction runs. Sessions served by the old runtime end with
    /// it, which is why the watcher that calls this is opt-in.
    ///
    /// @param handle - the application handle the new runtime reports to.
    pub(crate) fn restart_runtime(&self, handle: &tauri::AppHandle) {
        self.stop_runtime();
        match Supervisor::start(handle) {
            Ok((supervisor, _)) => self.adopt(supervisor),
            Err(error) => runtime::report_failure(handle, &error),
        }
    }
}

fn main() {
    // Installed before the window exists, so an early signal is still safe.
    runtime::install_signal_handlers();

    tauri::Builder::default()
        .setup(|app| {
            app.manage(NewPi::default());
            let handle = app.handle().clone();

            match Supervisor::start(&handle) {
                Ok((supervisor, dev)) => {
                    if let Some(state) = handle.try_state::<NewPi>() {
                        state.adopt(supervisor);
                    }
                    // The development loop, only when `dev.json` asked for it:
                    // restarting the runtime ends the sessions it is serving, so
                    // a person who is also talking to the agent in this window
                    // keeps the embedded build unless they say otherwise.
                    if let Some(source) = dev {
                        if source.reload() {
                            dev::spawn_watcher(handle.clone(), source);
                        }
                    }
                }
                Err(error) => {
                    // Leave the boot screen open so the reason stays readable.
                    runtime::report_failure(&handle, &error);
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("NewPi n'a pas pu démarrer")
        .run(|handle, event| {
            // Closing the last window ends the app, and with it the runtime.
            if matches!(event, RunEvent::Exit) {
                if let Some(state) = handle.try_state::<NewPi>() {
                    state.stop_runtime();
                }
            }
        });
}
