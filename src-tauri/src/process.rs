//! Process supervision shared by the two children NewPi owns.
//!
//! NewPi runs two long lived processes: the harness runtime and the PocketBase
//! memory sidecar. Both are started in their own process group and both are
//! stopped the same way — a polite `SIGTERM` to the whole group, a grace
//! period, then `SIGKILL` — because a child that spawns helpers of its own must
//! never leave them behind.
//!
//! The group is what matters. Signalling the child alone would leave the
//! harness's persistent shells, background jobs, and the sidecar's own
//! children running after NewPi closes.

use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// Grace period between the polite stop signal and the forced one.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(6);

/// A child process that owns a process group.
pub struct GroupChild {
    child: Child,
    /// Process group identifier, equal to the child's pid because the group is
    /// created with the child as its leader. Zero means "no group".
    group: i32,
}

impl GroupChild {
    /// Spawn `command` as the leader of a new process group.
    ///
    /// The caller configures the command; this only adds the group and the
    /// spawn itself, so both callers keep their own pipes and environment.
    ///
    /// @param command - the fully configured command to run.
    /// @returns the supervised child.
    /// @throws a message naming the program when the spawn fails.
    pub fn spawn(command: &mut Command) -> Result<Self, String> {
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // A dedicated group lets everything the child starts be signalled
            // together, and keeps NewPi's own group out of it.
            command.process_group(0);
        }

        let child = command
            .spawn()
            .map_err(|error| format!("Impossible de lancer {} : {error}", program_of(command)))?;
        let group = i32::try_from(child.id()).unwrap_or(0);
        Ok(Self { child, group })
    }

    /// The process group identifier, for the signal handler's static slot.
    pub fn group(&self) -> i32 {
        self.group
    }

    /// Claim the child's standard output, leaving `None` on later calls.
    pub fn take_stdout(&mut self) -> Option<std::process::ChildStdout> {
        self.child.stdout.take()
    }

    /// Claim the child's standard error, leaving `None` on later calls.
    pub fn take_stderr(&mut self) -> Option<std::process::ChildStderr> {
        self.child.stderr.take()
    }

    /// Whether the child has already exited.
    pub fn has_exited(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(Some(_)))
    }

    /// Ask the whole group to stop, then force it after the grace period.
    ///
    /// Safe to call more than once and from a `Drop`: a child that already
    /// exited is simply reaped.
    pub fn shutdown(&mut self) {
        if self.has_exited() {
            return;
        }
        signal_group(self.group, libc::SIGTERM);

        let deadline = Instant::now() + SHUTDOWN_GRACE;
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => thread::sleep(Duration::from_millis(100)),
                Err(_) => break,
            }
        }

        signal_group(self.group, libc::SIGKILL);
        let _ = self.child.wait();
    }
}

impl Drop for GroupChild {
    fn drop(&mut self) {
        // Never leave an orphan behind, however the application exits.
        self.shutdown();
    }
}

/// Signal a whole process group. A negative identifier addresses the group
/// rather than a single process.
pub fn signal_group(group: i32, signal: libc::c_int) {
    #[cfg(unix)]
    if group > 0 {
        unsafe {
            libc::kill(-group, signal);
        }
    }
    #[cfg(not(unix))]
    let _ = (group, signal);
}

/// True while at least one process remains in the group.
#[cfg(test)]
pub fn group_is_alive(group: i32) -> bool {
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

/// The program a command will run, for error messages.
fn program_of(command: &Command) -> std::borrow::Cow<'_, str> {
    command.get_program().to_string_lossy()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shutdown_stops_the_whole_group() {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg("sleep 300 & wait");
        let mut child = GroupChild::spawn(&mut command).expect("spawn");
        let group = child.group();
        assert!(group_is_alive(group));

        child.shutdown();

        let deadline = Instant::now() + Duration::from_secs(5);
        while group_is_alive(group) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        assert!(
            !group_is_alive(group),
            "a process from the group outlived shutdown",
        );
    }

    #[test]
    fn shutdown_is_idempotent() {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg("exit 0");
        let mut child = GroupChild::spawn(&mut command).expect("spawn");
        // Give the child a moment to exit on its own.
        thread::sleep(Duration::from_millis(200));
        child.shutdown();
        child.shutdown();
    }
}
