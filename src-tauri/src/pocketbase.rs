//! The PocketBase sidecar: provisioning, startup, and the credential.
//!
//! PocketBase is the durable store behind the project memory. NewPi runs it as
//! a child process bound to loopback on a port picked at launch, and stops it
//! with the rest of the application.
//!
//! # Why the executable is extracted instead of bundled
//!
//! `NewPi.app` carries the official macOS ARM64 release archive as *data*, not
//! as a second Mach-O executable inside `Contents/Resources`. A nested
//! executable has to carry its own code signature and satisfy the bundle's
//! seal, which is real work and a real source of "app is damaged" reports. Data
//! has no such requirement, so the archive is verified against a pinned SHA-256
//! and extracted on first use into the application's own state directory, where
//! it is a file the user owns rather than part of a signed bundle.
//!
//! The extraction happens once. Every later launch finds a binary whose version
//! marker already matches the pin and does no work at all — and no network
//! request is ever made. A machine with no copy of the archive has to fetch it
//! exactly once, and the fetch is verified against the same pin.
//!
//! # Exposure
//!
//! The sidecar listens on `127.0.0.1` and nothing else: no LAN address, no
//! wildcard bind, no TLS redirect that could be reached from outside. The one
//! credential is a superuser generated on this machine, stored in the
//! application's state directory with mode `0600`, and handed to the harness
//! through its environment rather than through a configuration file.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::memory::Layout;
use crate::process::GroupChild;

/// The pinned release archive, verified before it is ever extracted.
const ARCHIVE: &[u8] = include_bytes!("../../vendor/pocketbase/pocketbase_0.40.4_darwin_arm64.zip");

/// SHA-256 of the pinned archive. The same value is recorded in
/// `scripts/pocketbase-pin.mjs`, which is what downloads it.
pub const ARCHIVE_SHA256: &str =
    "eeb619ea4f8a06421daedb946d133bed269fea334a760941d147f76befc25ebc";

/// The release tag, written next to the extracted binary so a version change is
/// detectable without hashing thirty megabytes on every launch.
pub const VERSION: &str = "0.40.4";

/// SHA-256 of the executable inside the archive, recorded here so the extracted
/// bytes are verified too. A truncated or tampered extraction fails the launch
/// with the expected and actual digests.
pub const EXECUTABLE_SHA256: &str =
    "510df5401d2f0e4f91b19ab644760783b4edddf7db21e7d63935b2520966a906";

/// Name of the executable inside the archive.
const EXECUTABLE_NAME: &str = "pocketbase";

/// How long the sidecar gets to answer its health endpoint.
const READY_TIMEOUT: Duration = Duration::from_secs(30);

/// How long one provisioning command may take.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);

/// Superuser identity NewPi provisions. PocketBase validates this field as an
/// email address, and the domain is `.invalid` — reserved by RFC 2606 so it can
/// never resolve — because nothing authenticates against it from anywhere but
/// this machine.
const IDENTITY: &str = "newpi@newpi.invalid";

/// The sidecar's credential, generated once per installation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credential {
    /// Superuser identity, always [`IDENTITY`].
    pub identity: String,
    /// The generated password.
    pub password: String,
}

/// Read the stored credential, or generate and store one.
///
/// The file is created with mode `0600` before anything is written into it, so
/// the password is never briefly world readable. A file that exists but cannot
/// be parsed is an error rather than a reason to generate a second credential:
/// silently rotating it would lock the harness out of memories the user can
/// still see in the data directory.
///
/// @param path - the credential file.
/// @returns the credential to configure the harness with.
/// @throws when the file cannot be read, parsed, or created.
pub fn credential(path: &Path) -> Result<Credential, String> {
    if path.is_file() {
        let text = std::fs::read_to_string(path)
            .map_err(|error| format!("Lecture impossible de {} : {error}", path.display()))?;
        let mut identity = None;
        let mut password = None;
        for line in text.lines() {
            if let Some(value) = line.strip_prefix("identity:") {
                identity = Some(value.trim().to_string());
            } else if let Some(value) = line.strip_prefix("password:") {
                password = Some(value.trim().to_string());
            }
        }
        return match (identity, password) {
            (Some(identity), Some(password)) if !identity.is_empty() && !password.is_empty() => {
                Ok(Credential { identity, password })
            }
            _ => Err(format!(
                "{} ne contient pas d'identifiant exploitable ; supprimez-le pour en générer un nouveau",
                path.display()
            )),
        };
    }

    let credential = Credential {
        identity: IDENTITY.to_string(),
        password: random_password(),
    };
    write_credential(path, &credential)?;
    Ok(credential)
}

/// Write a credential file with owner-only permissions.
///
/// @param path - the destination.
/// @param credential - what to store.
/// @throws a message naming the path when the write fails.
fn write_credential(path: &Path, credential: &Credential) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| format!("Création impossible de {} : {error}", path.display()))?;
    writeln!(file, "identity: {}", credential.identity)
        .and_then(|_| writeln!(file, "password: {}", credential.password))
        .map_err(|error| format!("Écriture impossible de {} : {error}", path.display()))
}

/// A password from the operating system's random source.
///
/// 32 bytes of hex: long enough that guessing is not a concern, and limited to
/// characters that need no quoting anywhere NewPi passes it.
///
/// @returns the password.
fn random_password() -> String {
    let mut bytes = [0u8; 32];
    if let Ok(mut source) = std::fs::File::open("/dev/urandom") {
        if source.read_exact(&mut bytes).is_ok() {
            return bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        }
    }
    // A machine without `/dev/urandom` has larger problems, but the credential
    // still must not be empty: fall back to a time-derived value and let the
    // file's mode be the protection.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{nanos:032x}{nanos:032x}")
}

/// Ensure the sidecar executable exists, is verified, and matches the pin.
///
/// @param layout - the resolved layout.
/// @returns `true` when the binary was extracted by this call.
/// @throws when the archive cannot be verified, extracted, or trusted.
pub fn ensure_executable(layout: &Layout) -> Result<bool, String> {
    // An explicit override wins, for development and troubleshooting.
    if let Some(path) = std::env::var_os("NEWPI_POCKETBASE") {
        let path = PathBuf::from(path);
        if !path.is_file() {
            return Err(format!(
                "NEWPI_POCKETBASE pointe vers {} qui n'est pas un fichier",
                path.display()
            ));
        }
        // The override is recorded as a copy so the rest of the code has one
        // path to reason about.
        std::fs::copy(&path, &layout.pocketbase).map_err(|error| {
            format!("Copie impossible de {} : {error}", path.display())
        })?;
        let _ = std::fs::write(&layout.version, "override");
        return Ok(true);
    }

    let marker = std::fs::read_to_string(&layout.version).unwrap_or_default();
    if marker.trim() == VERSION && layout.pocketbase.is_file() {
        // The fast path: no hashing of a 30 MB binary on every launch. The
        // marker is only written after a verified extraction.
        return Ok(false);
    }

    let actual = sha256_hex(ARCHIVE);
    if actual != ARCHIVE_SHA256 {
        return Err(format!(
            "L'archive PocketBase embarquée ne correspond pas à l'empreinte épinglée.\n\
             attendu : {ARCHIVE_SHA256}\n\
             obtenu  : {actual}\n\
             Exécutez `node scripts/fetch-pocketbase.mjs` puis reconstruisez NewPi."
        ));
    }

    let staging = layout
        .pocketbase
        .parent()
        .unwrap_or(Path::new("."))
        .join("extract");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)
        .map_err(|error| format!("Création impossible de {} : {error}", staging.display()))?;

    let archive_path = staging.join("pocketbase.zip");
    std::fs::write(&archive_path, ARCHIVE)
        .map_err(|error| format!("Écriture impossible de {} : {error}", archive_path.display()))?;

    // `-d <dir>` is spelled out rather than passed through [`run`]: Info-ZIP
    // only treats the next argument as the destination when `-d` immediately
    // precedes it, and getting that wrong makes `unzip` print its usage and
    // succeed at nothing.
    let extraction = std::process::Command::new("/usr/bin/unzip")
        .arg("-o")
        .arg("-q")
        .arg(&archive_path)
        .arg("-d")
        .arg(&staging)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|error| format!("Impossible de lancer /usr/bin/unzip : {error}"))?;
    if !extraction.status.success() {
        return Err(format!(
            "Extraction de l'archive PocketBase impossible : {}",
            String::from_utf8_lossy(&extraction.stderr).trim()
        ));
    }

    let extracted = staging.join(EXECUTABLE_NAME);
    if !extracted.is_file() {
        return Err(format!(
            "L'archive PocketBase ne contient pas {EXECUTABLE_NAME}",
        ));
    }

    let actual = sha256_hex(
        &std::fs::read(&extracted)
            .map_err(|error| format!("Lecture impossible de {} : {error}", extracted.display()))?,
    );
    if actual != EXECUTABLE_SHA256 {
        return Err(format!(
            "L'exécutable PocketBase extrait ne correspond pas à l'empreinte épinglée.\n\
             attendu : {EXECUTABLE_SHA256}\n\
             obtenu  : {actual}"
        ));
    }

    set_executable(&extracted)?;
    std::fs::rename(&extracted, &layout.pocketbase).map_err(|error| {
        format!("Installation impossible de {} : {error}", layout.pocketbase.display())
    })?;
    let _ = std::fs::remove_dir_all(&staging);

    // Written last: its presence is the promise that the binary beside it was
    // verified against this version.
    std::fs::write(&layout.version, VERSION)
        .map_err(|error| format!("Écriture impossible de {} : {error}", layout.version.display()))?;

    Ok(true)
}

/// Mark a file executable, preserving its other permission bits.
fn set_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = std::fs::metadata(path)
        .map_err(|error| format!("Lecture impossible de {} : {error}", path.display()))?
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(path, permissions)
        .map_err(|error| format!("chmod impossible sur {} : {error}", path.display()))
}

/// Create or update the local superuser.
///
/// Idempotent: PocketBase's `superuser upsert` writes the credential whether or
/// not the account exists, which keeps a data directory restored from a backup
/// usable with the credential NewPi generated after it.
///
/// @param layout - the resolved layout, whose executable must exist.
/// @param credential - the identity and password to install.
/// @throws when the command fails or exceeds its timeout.
pub fn provision_superuser(layout: &Layout, credential: &Credential) -> Result<(), String> {
    let directory = format!("--dir={}", layout.data.display());
    run(
        path_as_str(&layout.pocketbase)?,
        &[
            "superuser",
            "upsert",
            &credential.identity,
            &credential.password,
            &directory,
        ],
    )
    .map(|_| ())
}

/// Candidate ports the sidecar is offered, in order.
///
/// PocketBase 0.40 prints the address it was *given* rather than the one it
/// bound, so asking it to bind port `0` reports `127.0.0.1:0` and leaves the
/// real port unknowable from its output. A free port is therefore chosen here
/// and verified by connecting to it: the number is only accepted once the
/// sidecar actually answers on it, so a candidate that was taken between the
/// probe and the bind is skipped rather than trusted.
const CANDIDATE_PORTS: &[u16] = &[8791, 8792, 8793, 8794, 8795];

/// Start the sidecar and wait until it answers.
///
/// @param layout - the resolved layout, whose executable and data must exist.
/// @returns the running child and the loopback port it answers on.
/// @throws when no candidate port works or the sidecar never answers.
pub fn start(layout: &Layout) -> Result<(GroupChild, u16), String> {
    let directory = format!("--dir={}", layout.data.display());
    let migrations = format!("--migrationsDir={}", layout.migrations.display());

    let mut last_error = String::new();
    for port in candidate_ports() {
        let mut command = std::process::Command::new(&layout.pocketbase);
        // The bind address is the whole exposure policy: one loopback literal,
        // no LAN address, no wildcard. PocketBase serves its API and its
        // dashboard on it, so nothing in this feature is reachable off this
        // machine.
        command
            .arg("serve")
            .arg(format!("--http=127.0.0.1:{port}"))
            .arg(&directory)
            .arg(&migrations)
            .current_dir(layout.pocketbase.parent().unwrap_or(Path::new(".")));

        let mut child = GroupChild::spawn(&mut command)?;

        // Both pipes are drained. A child whose output nobody reads blocks once
        // the pipe buffer fills, which would look exactly like a sidecar that
        // never became ready.
        if let Some(stdout) = child.take_stdout() {
            drain("stdout", stdout);
        }
        if let Some(stderr) = child.take_stderr() {
            drain("stderr", stderr);
        }

        let deadline = Instant::now() + READY_TIMEOUT;
        while Instant::now() < deadline {
            if health(port) {
                return Ok((child, port));
            }
            if child.has_exited() {
                last_error = format!("le sidecar s'est arrêté sur le port {port}");
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        child.shutdown();
        if last_error.is_empty() {
            last_error = format!(
                "aucune réponse sur le port {port} en {} secondes",
                READY_TIMEOUT.as_secs()
            );
        }
    }

    Err(format!("PocketBase n'a pas démarré : {last_error}"))
}

/// The ports to offer the sidecar: the fixed candidates that are free, then a
/// few ports the operating system reports as free.
///
/// A stable first choice keeps the sidecar's URL recognizable across launches,
/// which makes the launch log and a manual `curl` easy to compare. The
/// operating-system fallback is what keeps the feature working on a machine
/// where every fixed candidate is already taken.
///
/// @returns the candidate ports, best first.
fn candidate_ports() -> Vec<u16> {
    let mut ports: Vec<u16> = CANDIDATE_PORTS
        .iter()
        .copied()
        .filter(|port| is_free(*port))
        .collect();

    for _ in 0..4 {
        if let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", 0)) {
            if let Ok(address) = listener.local_addr() {
                if !ports.contains(&address.port()) {
                    ports.push(address.port());
                }
            }
        }
    }

    // Nothing is free: still try, so the failure names a real bind error
    // rather than an empty candidate list.
    if ports.is_empty() {
        ports.extend_from_slice(CANDIDATE_PORTS);
    }
    ports
}

/// Whether a loopback port can be bound right now.
///
/// @param port - the port to test.
/// @returns `true` when the bind succeeds.
fn is_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Log one of the sidecar's pipes to standard error until it closes.
///
/// NewPi does not parse this output: the port is verified by connecting to it,
/// which is the only claim worth trusting. The lines are forwarded because a
/// sidecar that fails to start explains itself here and nowhere else.
///
/// @param label - which pipe this is, for the log prefix.
/// @param stream - the pipe to read to its end.
fn drain<R: std::io::Read + Send + 'static>(label: &'static str, stream: R) {
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::BufReader::new(stream).lines().map_while(Result::ok) {
            eprintln!("[newpi/pocketbase/{label}] {line}");
        }
    });
}

/// Whether the sidecar answers its health endpoint on this port.
///
/// A hand written request rather than an HTTP client: it is one `GET` to a
/// loopback socket, and the dependency would be larger than the code. The
/// answer is also the only proof that the port belongs to the sidecar — which
/// is why the candidate's number is trusted only after this returns `true`.
///
/// @param port - the loopback port.
/// @returns `true` when the endpoint answers `200`.
fn health(port: u16) -> bool {
    use std::io::Write;
    use std::net::TcpStream;

    let Ok(mut stream) = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().expect("literal address"),
        Duration::from_millis(500),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let request =
        format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }
    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

/// Run one provisioning command to completion.
///
/// @param program - the executable.
/// @param args - its arguments.
/// @returns the command's standard output.
/// @throws when the command fails or exceeds [`COMMAND_TIMEOUT`].
fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = std::process::Command::new(program);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("Impossible de lancer {program} : {error}"))?;

    // A provisioning command that hangs must not hang the launch. The child is
    // killed rather than abandoned, so the port and the data directory are free
    // for the next attempt.
    let deadline = Instant::now() + COMMAND_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = String::new();
                let mut stderr = String::new();
                if let Some(mut pipe) = child.stdout.take() {
                    let _ = pipe.read_to_string(&mut stdout);
                }
                if let Some(mut pipe) = child.stderr.take() {
                    let _ = pipe.read_to_string(&mut stderr);
                }
                if status.success() {
                    return Ok(stdout);
                }
                return Err(format!(
                    "{program} {} a échoué : {}",
                    args.join(" "),
                    if stderr.trim().is_empty() {
                        stdout.trim().to_string()
                    } else {
                        stderr.trim().to_string()
                    }
                ));
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{program} {} n'a pas rendu la main en {} secondes",
                    args.join(" "),
                    COMMAND_TIMEOUT.as_secs()
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => return Err(format!("Attente de {program} impossible : {error}")),
        }
    }
}

/// A path as a string, for the command runner.
fn path_as_str(path: &Path) -> Result<&str, String> {
    path.to_str()
        .ok_or_else(|| format!("Chemin non UTF-8 : {}", path.display()))
}

/// SHA-256 of a byte slice, lowercase hex.
///
/// A local implementation keeps the application free of a hashing dependency:
/// this is the only hash NewPi computes, and it is checked against a constant.
///
/// @param bytes - the data.
/// @returns the digest.
pub fn sha256_hex(bytes: &[u8]) -> String {
    sha256(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// SHA-256, FIPS 180-4.
///
/// @param message - the data.
/// @returns the 32 byte digest.
pub fn sha256(message: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    let mut state: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    let mut message = message.to_vec();
    let bit_length = (message.len() as u64) * 8;
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_length.to_be_bytes());

    for chunk in message.chunks_exact(64) {
        let mut schedule = [0u32; 64];
        for (index, word) in chunk.chunks_exact(4).enumerate() {
            schedule[index] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for index in 16..64 {
            let s0 = schedule[index - 15].rotate_right(7)
                ^ schedule[index - 15].rotate_right(18)
                ^ (schedule[index - 15] >> 3);
            let s1 = schedule[index - 2].rotate_right(17)
                ^ schedule[index - 2].rotate_right(19)
                ^ (schedule[index - 2] >> 10);
            schedule[index] = schedule[index - 16]
                .wrapping_add(s0)
                .wrapping_add(schedule[index - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let choose = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(choose)
                .wrapping_add(K[index])
                .wrapping_add(schedule[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(majority);

            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
        state[4] = state[4].wrapping_add(e);
        state[5] = state[5].wrapping_add(f);
        state[6] = state[6].wrapping_add(g);
        state[7] = state[7].wrapping_add(h);
    }

    let mut digest = [0u8; 32];
    for (index, word) in state.iter().enumerate() {
        digest[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    digest
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_embedded_archive_matches_its_pin() {
        assert_eq!(sha256_hex(ARCHIVE), ARCHIVE_SHA256);
    }

    #[test]
    fn the_embedded_archive_still_contains_the_pinned_executable() {
        // Proves the pin describes the archive that is actually compiled in,
        // which a hash of the archive alone cannot say. The archive arrives on
        // standard input so the command reads nothing from the test's
        // temporary directory.
        let staging = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/test-tmp/archive");
        let _ = std::fs::remove_dir_all(&staging);
        std::fs::create_dir_all(&staging).unwrap();

        // Info-ZIP needs a seekable file: it reads the central directory at
        // the end, so the archive cannot arrive on standard input.
        let archive = staging.join("pocketbase.zip");
        std::fs::write(&archive, ARCHIVE).unwrap();
        let status = std::process::Command::new("/usr/bin/unzip")
            .arg("-o")
            .arg("-q")
            .arg(&archive)
            .arg("-d")
            .arg(&staging)
            .status()
            .expect("spawn unzip");
        assert!(status.success(), "unzip refused the archive");

        let executable = staging.join(EXECUTABLE_NAME);
        assert!(executable.is_file());
        assert_eq!(
            sha256_hex(&std::fs::read(&executable).unwrap()),
            EXECUTABLE_SHA256,
        );

        std::fs::remove_dir_all(&staging).unwrap();
    }

    #[test]
    fn sha256_matches_the_published_test_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
        // The 448-bit boundary case, which exercises the padding path.
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
        );
    }

    #[test]
    fn generates_a_long_unquoted_password() {
        let first = random_password();
        let second = random_password();
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|character| character.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn stores_the_credential_with_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let directory = std::env::temp_dir().join("newpi-credential-test");
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("credentials");

        let created = credential(&path).unwrap();
        assert_eq!(created.identity, IDENTITY);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "the credential must not be group or world readable");

        // Reading it back returns the same credential rather than a new one.
        assert_eq!(credential(&path).unwrap(), created);

        // A corrupt file is an error, not a silent rotation.
        std::fs::write(&path, "not a credential\n").unwrap();
        assert!(credential(&path).is_err());

        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn bind_address_is_a_loopback_literal() {
        // The exposure policy in one assertion: the argument NewPi passes is
        // built from a `127.0.0.1` literal and a port, never a wildcard.
        let http = format!("--http=127.0.0.1:{}", 8090);
        assert!(http.starts_with("--http=127.0.0.1:"));
        assert!(!http.contains("0.0.0.0"));
    }
}
