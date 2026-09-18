// Pin the exact PocketBase build NewPi runs as its local memory sidecar.
//
// This manifest is the single source of truth for three things the application
// must agree on: which upstream release is vendored, which archive is the
// official macOS ARM64 asset, and which SHA-256 that archive must have. The
// Rust sidecar reads the same numbers at runtime, so a mismatch between the
// vendored archive and this file is a startup error rather than a silent
// downgrade.
//
// Refresh it with `node scripts/fetch-pocketbase.mjs --version vX.Y.Z`, which
// downloads the release's own `checksums.txt` and copies the matching line
// here. Never hand-edit a hash.

/** The vendored PocketBase release. */
export const POCKETBASE_VERSION = 'v0.40.4';

/** The upstream repository the release comes from. */
export const POCKETBASE_REPOSITORY = 'pocketbase/pocketbase';

/** The official asset for this platform, and nothing else. */
export const POCKETBASE_ASSET = 'pocketbase_0.40.4_darwin_arm64.zip';

/** SHA-256 of that asset, as published in the release's `checksums.txt`. */
export const POCKETBASE_SHA256 = 'eeb619ea4f8a06421daedb946d133bed269fea334a760941d147f76befc25ebc';

/** Size of the archive in bytes, as published in the release. */
export const POCKETBASE_BYTES = 12065114;

/** The single file extracted from the archive and executed. */
export const POCKETBASE_EXECUTABLE = 'pocketbase';

/** Where the pinned archive lives inside the repository. */
export const POCKETBASE_ARCHIVE_PATH = 'vendor/pocketbase/pocketbase_0.40.4_darwin_arm64.zip';

/**
 * The upstream download URL for the pinned asset.
 *
 * @param version - the release tag; defaults to the pinned one.
 * @returns the absolute URL.
 */
export function pocketbaseDownloadUrl(version = POCKETBASE_VERSION) {
  return `https://github.com/${POCKETBASE_REPOSITORY}/releases/download/${version}/${POCKETBASE_ASSET}`;
}

/** Every fact about the sidecar binary, for logs and failure messages. */
export function pocketbasePin() {
  return {
    version: POCKETBASE_VERSION,
    asset: POCKETBASE_ASSET,
    sha256: POCKETBASE_SHA256,
    bytes: POCKETBASE_BYTES,
    archive: POCKETBASE_ARCHIVE_PATH,
    url: pocketbaseDownloadUrl(),
  };
}
