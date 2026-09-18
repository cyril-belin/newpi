#!/usr/bin/env node
/**
 * Vendor the pinned PocketBase sidecar into `vendor/pocketbase/`.
 *
 * PocketBase is not bundled inside `NewPi.app`. The application extracts this
 * archive into its own Application Support directory on first launch, so the
 * executable never has to carry a second signature inside the bundle and the
 * data never has to live next to the code.
 *
 * Run once after cloning, or again with `--version` to move to another release:
 *
 *   node scripts/fetch-pocketbase.mjs
 *   node scripts/fetch-pocketbase.mjs --version v0.40.4
 *
 * The archive is verified against the release's own `checksums.txt` before it
 * is written, and against the pin recorded in `scripts/pocketbase-pin.mjs`
 * before it is accepted. A release whose published hash differs from the pin is
 * a hard failure: that difference is exactly the signal worth stopping for.
 *
 * Nothing here runs at application startup. `pnpm dev` and `pnpm build` only
 * check that the archive is present.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/**
 * Read the version requested on the command line, if any.
 *
 * @returns the release tag, or `undefined` to use the pin.
 */
function requestedVersion() {
  const index = process.argv.indexOf('--version');
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || !value.startsWith('v')) {
    console.error('usage: node scripts/fetch-pocketbase.mjs [--version vX.Y.Z]');
    process.exit(2);
  }
  return value;
}

/**
 * Fetch a URL and return its bytes, failing loud on any non-200.
 *
 * @param url - the absolute URL.
 * @returns the response body.
 */
async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Extract the published SHA-256 for one asset from a release `checksums.txt`.
 *
 * @param text - the checksum file's contents.
 * @param asset - the asset file name.
 * @returns the lowercase hex digest.
 */
function publishedDigest(text, asset) {
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match !== null && match[2].trim() === asset) return match[1].toLowerCase();
  }
  throw new Error(`checksums.txt has no entry for ${asset}`);
}

/**
 * SHA-256 of a buffer, lowercase hex.
 *
 * @param buffer - the bytes.
 * @returns the digest.
 */
function digestOf(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

const version = requestedVersion();
const pinUrl = new URL('./pocketbase-pin.mjs', import.meta.url);
const pin = await import(pinUrl.href).then((module) => module.pocketbasePin());

if (version !== undefined && version !== pin.version) {
  // Re-pinning is a source change, not a side effect of a fetch: print what to
  // write and stop, so the committed pin and the vendored bytes never drift.
  const asset = `pocketbase_${version.replace(/^v/, '')}_darwin_arm64.zip`;
  const checksums = await download(
    `https://github.com/pocketbase/pocketbase/releases/download/${version}/checksums.txt`,
  );
  const digest = publishedDigest(checksums.toString('utf8'), asset);
  console.log(`Update scripts/pocketbase-pin.mjs to pin ${version}:\n`);
  console.log(`  POCKETBASE_VERSION = '${version}'`);
  console.log(`  POCKETBASE_ASSET   = '${asset}'`);
  console.log(`  POCKETBASE_SHA256  = '${digest}'`);
  console.log(`  POCKETBASE_ARCHIVE = 'vendor/pocketbase/${asset}'`);
  console.log('\nThen re-run this script without --version.');
  process.exit(1);
}

const archivePath = join(ROOT, pin.archive);

// A present archive that already matches the pin is the normal path, and it
// performs no network call at all.
try {
  const existing = await readFile(archivePath);
  if (digestOf(existing) === pin.sha256) {
    console.log(`pocketbase ${pin.version} already vendored at ${pin.archive}`);
    process.exit(0);
  }
  console.log(`${pin.archive} does not match the pin; re-downloading`);
} catch {
  console.log(`vendoring pocketbase ${pin.version} into ${pin.archive}`);
}

const checksums = await download(
  `https://github.com/pocketbase/pocketbase/releases/download/${pin.version}/checksums.txt`,
);
const expected = publishedDigest(checksums.toString('utf8'), pin.asset);
if (expected !== pin.sha256) {
  console.error(
    `refusing to vendor ${pin.asset}: the release publishes ${expected} but the pin records ${pin.sha256}`,
  );
  process.exit(1);
}

const archive = await download(pin.url);
const actual = digestOf(archive);
if (actual !== pin.sha256) {
  console.error(
    `refusing to vendor ${pin.asset}: downloaded bytes hash to ${actual}, expected ${pin.sha256}`,
  );
  process.exit(1);
}

await mkdir(dirname(archivePath), { recursive: true });
await writeFile(archivePath, archive);
console.log(`vendored ${pin.asset} (${archive.length} bytes, sha256 ${actual})`);
