/**
 * The backup and restore engine behind the console's second section.
 *
 * # The format
 *
 * A NewPi backup is one zip archive:
 *
 * ```
 * newpi-memory-20260912-205203.zip
 * ├── manifest.json            what this archive is, and what it holds
 * └── pb_data/
 *     ├── data.db              the memories themselves
 *     ├── auxiliary.db
 *     └── types.d.ts
 * ```
 *
 * The `pb_data/` entries are copied out of a snapshot PocketBase produced
 * itself, through its own backup API. That is the whole reason this format can
 * promise consistency: NewPi never reads `data.db` while the server is writing
 * it, and never stops the server to take a copy either.
 *
 * The manifest is what makes a restore safe to *offer*. It says which version
 * of NewPi wrote the archive, which version of PocketBase wrote the database
 * inside it, when it was made, and how many memories it holds — so a restore
 * can refuse an archive it cannot read, and can *prove* afterwards that the
 * database it now serves is the one the archive described.
 *
 * # The restore transaction
 *
 * A restore replaces every memory of every project on this machine, so it is
 * treated as a transaction with a rollback, not as a file copy:
 *
 * 1. the archive is verified — integrity, format, version, digests, SQLite
 *    header — before anything is touched;
 * 2. a safety archive of the current database is taken and kept;
 * 3. memory writes are held off for the whole operation;
 * 4. the archive is handed to PocketBase, which restarts itself around it;
 * 5. the result is verified against the manifest by reading the database back,
 *    and rolled back to the safety archive if it does not match.
 *
 * @module newpi-plugin-memory-console/backup
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  PlatformError,
  archiveEntries,
  archiveEntry,
  archiveIsIntact,
  directoryEntries,
  extractEntries,
  isSqliteFile,
  revealDirectory,
  savePanel,
  sha256File,
  zipEntries,
} from './platform.js';

/** The `format` every NewPi backup manifest carries. */
export const BACKUP_FORMAT = 'newpi-memory-backup';

/** The format this build writes. */
export const BACKUP_FORMAT_VERSION = 1;

/** The newest format this build can read. An archive above it was written by a
 * newer NewPi and is refused with a message that says so, rather than being
 * half-read. */
export const MAX_READABLE_FORMAT_VERSION = 1;

/** The manifest's file name inside the archive. */
export const MANIFEST_ENTRY = 'manifest.json';

/** The directory the database entries live under inside the archive. */
export const DATA_PREFIX = 'pb_data/';

/** The one entry every backup must hold. */
export const REQUIRED_ENTRY = `${DATA_PREFIX}data.db`;

/** The entries PocketBase's own snapshot holds, and therefore the entries a
 * NewPi archive carries, in the order they are handled. */
export const SIDECAR_ENTRIES = ['data.db', 'auxiliary.db', 'types.d.ts'];

/** How long a restarted sidecar gets to answer its health endpoint. */
const HEALTH_TIMEOUT_MS = 30_000;

/** How long the sidecar gets to replace its database file after a restore.
 * Measured on the real binary: `POST /api/backups/{key}/restore` answers 204
 * about a second before the new database is in place, and until it is, the
 * server happily answers the old one — so a restore that is verified the
 * moment the call returns verifies the wrong database. */
const REPLACEMENT_TIMEOUT_MS = 30_000;

/** How long a verification keeps re-reading while the database settles. */
const VERIFY_TIMEOUT_MS = 20_000;

/** How long to wait between two readings while the sidecar settles. */
const POLL_INTERVAL_MS = 150;

/** How many local archives the console lists, newest first. */
export const MAX_LISTED_BACKUPS = 20;

/** Where an archive the user picked is held while it is inspected and
 * restored. Inside the backups directory, but hidden and short-lived: it is a
 * copy of a file the user chose, not one of NewPi's own archives. */
export const INCOMING_DIRECTORY = '.incoming';

/** Largest archive the window may hand over, in bytes. A memory database is
 * measured in megabytes; this is a ceiling that fails a runaway upload with a
 * sentence instead of filling the disk. */
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

/**
 * Parse a dotted version into its three numbers.
 *
 * @param value - the version string, e.g. `0.40.4`.
 * @returns the parts, or `null` when the string is not a version.
 */
export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? '').trim());
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * Order two versions.
 *
 * @param left - the first version.
 * @param right - the second version.
 * @returns `-1`, `0` or `1`; an unparsable version sorts below every real one.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  for (const part of ['major', 'minor', 'patch']) {
    if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1;
  }
  return 0;
}

/**
 * The file name one archive is given.
 *
 * The timestamp is local time so a user reading a folder of them recognises
 * when each was taken; the manifest holds the exact instant in UTC.
 *
 * @param options - the name.
 * @param options.at - the instant.
 * @param options.label - an optional infix, e.g. `avant-restauration`.
 * @returns the file name, extension included.
 */
export function backupFileName({ at = new Date(), label = '' } = {}) {
  const pad = (value) => String(value).padStart(2, '0');
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const infix = label.length > 0 ? `-${label}` : '';
  return `newpi-memory${infix}-${stamp}.zip`;
}

/**
 * Build the manifest one archive carries.
 *
 * @param options - the manifest.
 * @param options.at - the instant the archive is made.
 * @param options.newpiVersion - the NewPi version that wrote it.
 * @param options.pocketbaseVersion - the PocketBase version inside it.
 * @param options.projectId - the scope the console was opened for.
 * @param options.collection - the collection the memories live in.
 * @param options.entries - the archive's entries, with their sizes and digests.
 * @param options.memories - the counts the archive holds.
 * @returns the manifest object.
 */
export function buildManifest({
  at,
  newpiVersion,
  pocketbaseVersion,
  projectId,
  collection,
  entries,
  memories,
}) {
  return {
    format: BACKUP_FORMAT,
    format_version: BACKUP_FORMAT_VERSION,
    created_at: at.toISOString(),
    created_by: { name: 'NewPi', version: newpiVersion },
    pocketbase: { version: pocketbaseVersion },
    source: { project_id: projectId, collection },
    contents: {
      entries: entries.map((entry) => entry.name),
      bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
      sha256: Object.fromEntries(entries.map((entry) => [entry.name, entry.sha256])),
    },
    memories,
    reader: {
      min_format_version: 1,
      max_format_version: MAX_READABLE_FORMAT_VERSION,
    },
  };
}

/**
 * Decide whether a manifest describes an archive this build can restore.
 *
 * Every refusal names what is wrong and what to do about it. The "too recent"
 * case is the one worth spelling out to a user: it is not corruption, it is a
 * NewPi that is older than the backup, and the answer is to update NewPi.
 *
 * @param manifest - the parsed manifest, of unknown provenance.
 * @param options - what this build is.
 * @param options.pocketbaseVersion - the PocketBase version NewPi embeds.
 * @returns `{ok, code, message, warning}`; `warning` is set when the archive is
 * restorable but something about it is worth saying first.
 */
export function checkCompatibility(manifest, { pocketbaseVersion }) {
  if (manifest === null || typeof manifest !== 'object') {
    return {
      ok: false,
      code: 'MANIFEST_UNREADABLE',
      message:
        "Le manifeste de cette sauvegarde est illisible : ce fichier n'est pas une sauvegarde NewPi.",
    };
  }
  if (manifest.format !== BACKUP_FORMAT) {
    return {
      ok: false,
      code: 'FORMAT_UNKNOWN',
      message:
        "Ce fichier n'est pas une sauvegarde de mémoire NewPi " +
        `(format annoncé : ${JSON.stringify(manifest.format ?? null)}).`,
    };
  }

  const version = manifest.format_version;
  if (!Number.isInteger(version) || version < 1) {
    return {
      ok: false,
      code: 'FORMAT_INVALID',
      message: 'Le manifeste ne déclare pas de version de format exploitable.',
    };
  }
  if (version > MAX_READABLE_FORMAT_VERSION) {
    return {
      ok: false,
      code: 'FORMAT_TOO_RECENT',
      message:
        `Cette sauvegarde est trop récente : elle utilise le format ${version}, ` +
        `et cette version de NewPi lit jusqu'au format ${MAX_READABLE_FORMAT_VERSION}. ` +
        'Mettez NewPi à jour pour la restaurer.',
    };
  }

  const entries = Array.isArray(manifest.contents?.entries) ? manifest.contents.entries : [];
  if (!entries.includes(REQUIRED_ENTRY)) {
    return {
      ok: false,
      code: 'ARCHIVE_INCOMPLETE',
      message:
        `Cette sauvegarde ne contient pas ${REQUIRED_ENTRY} : ` +
        'elle ne peut pas remplacer la base locale.',
    };
  }

  const archived = manifest.pocketbase?.version;
  if (typeof archived !== 'string' || parseVersion(archived) === null) {
    return {
      ok: false,
      code: 'POCKETBASE_VERSION_UNKNOWN',
      message: "Le manifeste ne dit pas quelle version de PocketBase a écrit cette base.",
    };
  }
  if (compareVersions(archived, pocketbaseVersion) > 0) {
    return {
      ok: false,
      code: 'POCKETBASE_TOO_RECENT',
      message:
        `Cette sauvegarde a été écrite par PocketBase ${archived}, plus récent que le ` +
        `PocketBase ${pocketbaseVersion} embarqué dans ce NewPi. ` +
        'Utilisez une version de NewPi au moins aussi récente pour la restaurer.',
    };
  }

  return {
    ok: true,
    code: 'OK',
    message: 'Sauvegarde compatible.',
    warning:
      compareVersions(archived, pocketbaseVersion) < 0
        ? `Sauvegarde écrite par PocketBase ${archived} ; NewPi embarque ${pocketbaseVersion}, ` +
          'qui appliquera ses migrations au redémarrage.'
        : undefined,
  };
}

/**
 * Parse and vet a manifest read out of an archive.
 *
 * @param bytes - the manifest's bytes.
 * @param options - what this build is.
 * @returns the compatibility verdict plus the manifest when it parsed.
 */
export function readManifest(bytes, options) {
  let manifest = null;
  try {
    manifest = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return {
      ok: false,
      code: 'MANIFEST_UNREADABLE',
      message:
        "Le manifeste de cette sauvegarde est illisible : ce fichier n'est pas une sauvegarde NewPi.",
      manifest: null,
    };
  }
  return { ...checkCompatibility(manifest, options), manifest };
}

/**
 * The one-line summary of a manifest the console lists.
 *
 * @param manifest - a parsed manifest.
 * @returns the summary, or `null` when there is nothing to summarise.
 */
export function summarizeManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object') return null;
  return {
    created_at: typeof manifest.created_at === 'string' ? manifest.created_at : '',
    newpi_version:
      typeof manifest.created_by?.version === 'string' ? manifest.created_by.version : '',
    pocketbase_version:
      typeof manifest.pocketbase?.version === 'string' ? manifest.pocketbase.version : '',
    project_id: typeof manifest.source?.project_id === 'string' ? manifest.source.project_id : '',
    total: Number.isFinite(manifest.memories?.total) ? manifest.memories.total : null,
  };
}

/**
 * The backup engine: one instance per harness launch, owned by the plugin.
 *
 * It is deliberately not a Cordis service. It has exactly one caller — the
 * console's own routes — and it is the only place in NewPi where a database is
 * replaced, so keeping it out of the service registry keeps that fact visible.
 */
export class MemoryBackups {
  /**
   * @param options - the engine's collaborators.
   * @param options.memory - the memory service (`ctx.pocketbaseMemory`).
   * @param options.directory - where NewPi keeps the backups it makes.
   * @param options.snapshots - where the sidecar keeps the snapshots it makes
   *   (`<pb_data>/backups`). NewPi reads the file PocketBase wrote there; the
   *   download endpoint requires a signed file token the superuser API does not
   *   hand out, and reading the file the sidecar just wrote is exactly as
   *   consistent.
   * @param options.dataDir - `<pb_data>`, the directory holding `data.db`. It
   *   is read for one thing only: watching the database file change, which is
   *   how a restore knows the sidecar has actually swapped it.
   * @param options.versions - `{newpi, pocketbase}`.
   * @param options.now - the clock; defaults to `Date.now`.
   * @param options.panel - how the destination is asked for; defaults to the
   *   real macOS panel. A test replaces it, because the real one waits for a
   *   person and a test cannot be a person.
   */
  constructor({
    memory,
    directory,
    snapshots,
    dataDir,
    versions,
    now = () => new Date(),
    panel = savePanel,
  }) {
    this.memory = memory;
    this.directory = directory;
    this.snapshots = snapshots;
    this.dataDir = dataDir;
    this.panel = panel;
    this.versions = versions;
    this.now = now;
    /** Set while a backup or a restore is running. */
    this.busy = false;
    /** What the running operation is doing, for the console's progress line. */
    this.activity = '';
  }

  /**
   * Everything the Backup section needs to render itself.
   *
   * @returns the directory, the versions, whether an operation is running, and
   * the newest local archives with the summary of their manifests.
   */
  async status() {
    const files = await directoryEntries(this.directory);
    files.sort((left, right) => right.name.localeCompare(left.name));
    const listed = files.slice(0, MAX_LISTED_BACKUPS);

    const backups = [];
    for (const file of listed) {
      backups.push({
        name: file.name,
        path: file.path,
        bytes: file.bytes,
        modified: file.modified,
        manifest: await this.manifestOf(file.path),
        kind: file.name.includes('avant-restauration') ? 'safety' : 'manual',
      });
    }

    return {
      directory: this.directory,
      busy: this.busy,
      activity: this.activity,
      versions: { ...this.versions },
      backups,
      listed: backups.length,
      total: files.length,
    };
  }

  /**
   * Read one local archive's manifest, without ever throwing.
   *
   * A file that is not a NewPi archive is listed as `null` rather than hidden:
   * the user put it there, or a previous version did, and a listing that
   * silently omits files from its own folder is worse than one that admits it
   * cannot read them.
   *
   * @param path - the archive path.
   * @returns the summary, or `null`.
   */
  async manifestOf(path) {
    try {
      const bytes = await archiveEntry(path, MANIFEST_ENTRY);
      const parsed = readManifest(bytes, { pocketbaseVersion: this.versions.pocketbase });
      return parsed.manifest === null ? null : summarizeManifest(parsed.manifest);
    } catch {
      return null;
    }
  }

  /**
   * Verify one archive completely, without touching the live database.
   *
   * @param path - the archive path.
   * @returns the archive's metadata, its manifest, the verdict, and the counts
   * the archive claims to hold.
   * @throws {PlatformError} when the path is not a readable file.
   */
  async inspectArchive(path) {
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isFile()) {
      throw new PlatformError(`Ce n'est pas un fichier : ${path}`);
    }
    const base = { path, name: path.split('/').pop() ?? path, bytes: info.size };

    if (!(await archiveIsIntact(path))) {
      return {
        ...base,
        ok: false,
        code: 'ARCHIVE_CORRUPT',
        message:
          "L'archive est corrompue : sa table des matières ou ses sommes de contrôle ne sont " +
          "pas intactes. Elle n'a pas été ouverte.",
        manifest: null,
        memories: null,
      };
    }

    let manifestBytes;
    try {
      manifestBytes = await archiveEntry(path, MANIFEST_ENTRY);
    } catch {
      return {
        ...base,
        ok: false,
        code: 'MANIFEST_MISSING',
        message: `Cette archive ne contient pas ${MANIFEST_ENTRY} : ce n'est pas une sauvegarde NewPi.`,
        manifest: null,
        memories: null,
      };
    }

    const parsed = readManifest(manifestBytes, { pocketbaseVersion: this.versions.pocketbase });
    const verdict = {
      ...base,
      ok: parsed.ok,
      code: parsed.code,
      message: parsed.message,
      warning: parsed.warning,
      manifest: parsed.manifest,
      memories: parsed.manifest?.memories ?? null,
    };
    if (!parsed.ok) return verdict;

    // The archive's own entry list must agree with its manifest: a manifest
    // that names a file the archive does not hold describes an archive that
    // does not exist, and a restore built on it would swap in a partial
    // database.
    const entries = await archiveEntries(path);
    const missing = parsed.manifest.contents.entries.filter((entry) => !entries.includes(entry));
    if (missing.length > 0) {
      return {
        ...verdict,
        ok: false,
        code: 'ARCHIVE_INCOMPLETE',
        message: `L'archive ne contient pas les fichiers annoncés par son manifeste : ${missing.join(', ')}.`,
      };
    }

    return verdict;
  }

  /**
   * Verify one archive's extracted contents against its manifest digests.
   *
   * @param manifest - the archive's manifest.
   * @param target - the directory the entries were extracted into.
   * @returns the verified entry names.
   * @throws {PlatformError} when a digest does not match, or the database is
   * not a database.
   */
  async verifyExtracted(manifest, target) {
    const verified = [];
    for (const entry of manifest.contents.entries) {
      const local = join(target, entry);
      const expected = manifest.contents.sha256?.[entry];
      if (typeof expected === 'string' && expected.length > 0) {
        const actual = await sha256File(local);
        if (actual !== expected) {
          throw new PlatformError(
            `L'archive est corrompue : l'empreinte de ${entry} ne correspond pas à son manifeste.`,
          );
        }
      }
      verified.push(entry);
    }

    if (!(await isSqliteFile(join(target, REQUIRED_ENTRY)))) {
      throw new PlatformError(
        `${REQUIRED_ENTRY} n'est pas une base SQLite : l'archive a été refusée avant toute modification.`,
      );
    }
    return verified;
  }

  /**
   * Take delivery of an archive the window read from the user's disk.
   *
   * The archive chooser is the window's own panel, so what arrives here is the
   * file's bytes rather than a path the host could have been handed. They are
   * written once into a holding directory inside the state directory — never
   * into the backups directory, so a file the user picked is never mistaken for
   * a backup NewPi made — and the path returned is what the inspection and the
   * restore then work from.
   *
   * The bytes are checked before they are written: an archive that does not
   * start with a zip header is refused here, with the message the section
   * shows, rather than three steps later.
   *
   * @param options - what the window sent.
   * @param options.name - the file's name, as the panel reported it.
   * @param options.bytes - the file's bytes.
   * @returns the path the archive was received at, and its size.
   * @throws {PlatformError} when the name or the bytes cannot be an archive.
   */
  async receive({ name, bytes }) {
    const buffer = Buffer.from(bytes);
    if (buffer.byteLength < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
      throw new PlatformError(
        "Ce fichier n'est pas une archive zip : il n'a pas été lu jusqu'au bout ni écrit sur le disque.",
      );
    }
    const safe = String(name ?? '')
      .split(/[\\/]/)
      .pop()
      .replace(/[^\w.\-]+/g, '_')
      .slice(-120);
    const filename = safe.toLowerCase().endsWith('.zip') ? safe : `${safe}.zip`;

    const holding = join(this.directory, INCOMING_DIRECTORY);
    await rm(holding, { recursive: true, force: true }).catch(() => {});
    await mkdir(holding, { recursive: true });
    const path = join(holding, filename);
    await writeFile(path, buffer);
    return { path, bytes: buffer.byteLength };
  }

  /**
   * Make one backup of the live database, through PocketBase's own machinery.
   *
   * The snapshot is taken by the sidecar, exported into the destination, and
   * the sidecar's own copy of it is removed again: the archive the user keeps
   * is the NewPi one, and `pb_data/backups` does not grow by one file per
   * backup the user makes.
   *
   * @param options - the backup.
   * @param options.destination - the file to write; a save panel is opened when
   *   it is absent and `pick` is true.
   * @param options.label - the file name infix, `avant-restauration` for the
   *   safety archive.
   * @param options.pick - whether to ask the user for a destination.
   * @returns the report, or `{cancelled: true}` when the user closed the panel.
   */
  async create({ destination, label = '', pick = true } = {}) {
    if (this.busy) throw new PlatformError('Une opération de sauvegarde est déjà en cours.');
    this.busy = true;
    try {
      const target =
        destination ?? (pick ? await this.#askDestination(label) : await this.unusedPath(label));
      if (target === null) return { cancelled: true };
      return await this.createInto(target, label);
    } finally {
      this.busy = false;
      this.activity = '';
    }
  }

  /**
   * The path a backup takes when the user is not asked.
   *
   * @param label - the file name infix.
   * @returns the absolute path inside the backups directory.
   */
  defaultPath(label = '') {
    return join(this.directory, backupFileName({ at: this.now(), label }));
  }

  /**
   * A path in the backups directory that no file occupies yet.
   *
   * The name has one-second resolution, so two backups taken in the same second
   * would otherwise be one file. Nothing NewPi writes is ever allowed to
   * replace an archive the user already has.
   *
   * @param label - the file name infix.
   * @returns an unused absolute path.
   */
  async unusedPath(label = '') {
    const name = backupFileName({ at: this.now(), label });
    const base = name.replace(/\.zip$/, '');
    let candidate = join(this.directory, name);
    let counter = 1;
    while ((await stat(candidate).catch(() => null)) !== null) {
      counter += 1;
      candidate = join(this.directory, `${base}-${counter}.zip`);
    }
    return candidate;
  }

  /** Ask the user where to write one archive. */
  async #askDestination(label) {
    this.activity = "Choix de l'emplacement";
    // The panel is opened *at* the backups directory, and AppleScript cannot
    // coerce a `POSIX file` for a directory that is not there: measured, the
    // panel then fails immediately with a conversion error instead of asking.
    // The directory is NewPi's own, so making sure of it is this function's job.
    await mkdir(this.directory, { recursive: true }).catch(() => {});
    const fallback = this.defaultPath(label);
    const chosen = await this.panel({
      prompt: 'Enregistrer la sauvegarde de la mémoire NewPi',
      name: fallback.split('/').pop(),
      directory: this.directory,
    });
    if (chosen === null) return null;
    // The panel returns what the user typed, which may lack the extension.
    return chosen.endsWith('.zip') ? chosen : `${chosen}.zip`;
  }

  /**
   * The shared body of every archive NewPi writes.
   *
   * @param target - the archive path to write.
   * @param label - the file name infix.
   * @returns the report: path, size, and manifest.
   * @throws {PlatformError} when the sidecar refuses to snapshot.
   */
  async createInto(target, label = '') {
    // Every archive NewPi writes goes through here, and every one of them is
    // written into a folder that may not exist yet: NewPi makes the backups
    // directory at launch, but a user can remove it, and the safety archive is
    // written before a restore touches anything. Creating the destination's
    // folder here is what makes "create a backup" work on a fresh state
    // directory instead of failing with a bare ENOENT.
    await mkdir(dirname(target), { recursive: true }).catch(() => {});
    this.activity = 'Instantané PocketBase';
    const key = await this.memory.backupCreate(`newpi-${Date.now().toString(36)}.zip`);
    const staging = await mkdtemp(join(tmpdir(), 'newpi-backup-'));

    try {
      const snapshot = await this.#extractSnapshot(key, staging);
      const entries = [];
      for (const name of SIDECAR_ENTRIES) {
        const local = join(snapshot, name);
        const info = await stat(local).catch(() => null);
        if (info === null || !info.isFile()) continue;
        entries.push({ name, bytes: info.size, sha256: await sha256File(local) });
      }
      if (!entries.some((entry) => entry.name === 'data.db')) {
        throw new PlatformError("L'instantané PocketBase ne contient pas data.db.");
      }

      const manifest = buildManifest({
        at: this.now(),
        newpiVersion: this.versions.newpi,
        pocketbaseVersion: this.versions.pocketbase,
        projectId: this.memory.projectId,
        collection: 'memories',
        entries: entries.map((entry) => ({ ...entry, name: `${DATA_PREFIX}${entry.name}` })),
        memories: { total: await this.memory.countAll() },
      });

      // The database entries are moved, not copied: they are already in the
      // staging directory, and a backup must not need twice the database's
      // size in free space.
      const database = join(staging, DATA_PREFIX);
      await mkdir(database, { recursive: true });
      for (const entry of entries) {
        await import('node:fs/promises').then((fs) =>
          fs.rename(join(snapshot, entry.name), join(database, entry.name)),
        );
      }
      await rm(snapshot, { recursive: true, force: true }).catch(() => {});

      await writeFile(
        join(staging, MANIFEST_ENTRY),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8',
      );

      const bytes = await zipEntries({
        source: staging,
        entries: [MANIFEST_ENTRY, DATA_PREFIX],
        destination: target,
      });

      return {
        cancelled: false,
        path: target,
        name: target.split('/').pop() ?? target,
        bytes,
        label,
        manifest,
      };
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      await this.#discardSnapshot(key);
    }
  }

  /**
   * Unpack the sidecar's snapshot into a directory of its own.
   *
   * @param key - the archive key the sidecar returned.
   * @param parent - where to create the directory.
   * @returns the directory holding the unpacked entries.
   * @throws {PlatformError} when the snapshot is missing or unreadable.
   */
  async #extractSnapshot(key, parent) {
    const archive = join(this.snapshots, key);
    const info = await stat(archive).catch(() => null);
    if (info === null || !info.isFile()) {
      throw new PlatformError(
        `PocketBase a annoncé une sauvegarde (${key}) mais le fichier est introuvable dans ${this.snapshots}.`,
      );
    }
    const directory = await mkdtemp(join(parent, 'snapshot-'));
    await extractEntries({ archive, target: directory, entries: SIDECAR_ENTRIES });
    return directory;
  }

  /** Remove the sidecar's own copy of a snapshot, best effort. */
  async #discardSnapshot(key) {
    try {
      await this.memory.backupDelete(key);
    } catch {
      // A leftover snapshot in `pb_data/backups` is untidy, not a failure: the
      // user's archive is already written and verified.
    }
  }

  /**
   * Restore one archive over the live database.
   *
   * @param options - the restore.
   * @param options.path - the archive to restore.
   * @param options.confirm - must be `true`; the caller owns the confirmation.
   * @returns the report: the archive, the safety archive, and what was read
   * back out of the restored database.
   * @throws {PlatformError} when the archive is refused, or the restore could
   * not be verified and the rollback also failed.
   */
  async restore({ path, confirm } = {}) {
    if (confirm !== true) {
      throw new PlatformError('La restauration doit être confirmée explicitement.');
    }
    if (this.busy) throw new PlatformError('Une opération de sauvegarde est déjà en cours.');

    const inspected = await this.inspectArchive(path);
    if (!inspected.ok) throw new PlatformError(inspected.message);

    this.busy = true;
    const report = {
      archive: { path: inspected.path, name: inspected.name, bytes: inspected.bytes },
      manifest: inspected.manifest,
      expected: inspected.memories,
      safety: null,
      restored_at: null,
      verification: null,
      rolled_back: false,
    };

    try {
      // The whole replacement runs with memory writes held off: a `remember`
      // that started before it is fine, one that would start during it waits.
      await this.memory.exclusive(async () => {
        this.activity = 'Sauvegarde de sécurité';
        const safety = await this.createInto(
          await this.unusedPath('avant-restauration'),
          'avant-restauration',
        );
        report.safety = { path: safety.path, name: safety.name, bytes: safety.bytes };

        try {
          this.activity = 'Restauration';
          await this.apply(inspected.path, inspected.manifest);
          this.activity = 'Vérification';
          report.verification = await this.verify(inspected.memories);
          report.restored_at = this.now().toISOString();

          if (!report.verification.matches) {
            throw new PlatformError(
              'La base restaurée ne correspond pas au manifeste de la sauvegarde : ' +
                `${report.verification.total} souvenirs lus, ${report.verification.expected_total} attendus.`,
            );
          }
        } catch (error) {
          // The safety archive exists precisely for this: put the database back
          // the way it was, then report both what failed and what was undone.
          this.activity = "Retour à l'état précédent";
          const rolledBack = await this.#rollback(report.safety.path, inspected.memories);
          report.rolled_back = rolledBack.restored;
          report.verification = rolledBack.verification;
          const detail = error instanceof Error ? error.message : String(error);
          throw new PlatformError(
            rolledBack.restored
              ? `${detail} La mémoire locale a été remise dans son état précédent.`
              : `${detail} Le retour à l'état précédent a échoué : restaurez ${report.safety.path} à la main.`,
            { cause: error },
          );
        }
      });
      return report;
    } finally {
      this.busy = false;
      this.activity = '';
    }
  }

  /**
   * Replace the live database with one archive's contents.
   *
   * The archive is unpacked into a staging directory, checked against its
   * manifest, rebuilt in the layout PocketBase's own restore expects, and handed
   * over through the sidecar's backup API — which restarts the server around the
   * new database by itself.
   *
   * @param path - the NewPi archive.
   * @param manifest - its manifest, when the caller already read it.
   * @throws {PlatformError} when any step refuses.
   */
  async apply(path, manifest = null) {
    const known = manifest ?? (await this.inspectArchive(path)).manifest;
    const before = await this.databaseStamp();
    const staging = await mkdtemp(join(tmpdir(), 'newpi-restore-'));
    try {
      await extractEntries({
        archive: path,
        target: staging,
        entries: known.contents.entries,
      });
      await this.verifyExtracted(known, staging);

      const database = join(staging, DATA_PREFIX);
      const present = [];
      for (const name of SIDECAR_ENTRIES) {
        const info = await stat(join(database, name)).catch(() => null);
        if (info !== null && info.isFile()) present.push(name);
      }

      const upload = join(staging, 'restauration.zip');
      await zipEntries({ source: database, entries: present, destination: upload });
      await this.memory.backupRestore({
        bytes: await readFile(upload),
        name: `newpi-restauration-${Date.now().toString(36)}.zip`,
      });

      await this.waitForReplacement(before);
      await this.waitForHealth();
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Put the database back after a failed restore.
   *
   * @param safetyPath - the safety archive taken before the restore.
   * @param expected - the manifest the rollback must reproduce, so a rollback
   *   that silently restored the wrong thing is itself a failure.
   * @returns whether the rollback took, and what was read back afterwards.
   */
  async #rollback(safetyPath, expected) {
    try {
      await this.apply(safetyPath);
      const verification = await this.verify({ total: expected?.total });
      return { restored: verification.matches, verification };
    } catch {
      return { restored: false, verification: null };
    }
  }

  /**
   * The identity of the live database file: its modification time and size.
   *
   * A restore replaces this file, so a stamp that differs from the one taken
   * before the call is the observable proof that the swap happened. It is not
   * a substitute for reading the memories back — it is what keeps that reading
   * from happening too early.
   *
   * @returns the stamp, or `null` when the file is not there.
   */
  async databaseStamp() {
    const info = await stat(join(this.dataDir, 'data.db')).catch(() => null);
    return info === null ? null : `${Math.round(info.mtimeMs)}:${info.size}`;
  }

  /**
   * Wait until the sidecar has replaced its database file.
   *
   * @param before - the stamp taken before the restore.
   * @returns whether a replacement was observed; a timeout is not an error by
   * itself, because the verification that follows is what has to agree.
   */
  async waitForReplacement(before) {
    if (before === null) return false;
    const deadline = Date.now() + REPLACEMENT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const now = await this.databaseStamp();
      if (now !== null && now !== before) return true;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return false;
  }

  /**
   * Wait until the sidecar answers again after its self-restart.
   *
   * @throws {PlatformError} when it never comes back.
   */
  async waitForHealth() {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    let last = '';
    while (Date.now() < deadline) {
      try {
        await this.memory.health();
        return;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new PlatformError(
      `PocketBase n'a pas répondu dans les ${HEALTH_TIMEOUT_MS / 1000} secondes qui ont suivi la restauration : ${last}`,
    );
  }

  /**
   * Read the restored database back and compare it with the manifest.
   *
   * This is the check the whole design exists to make possible: not "the files
   * were written", but "the memories the archive described are readable".
   *
   * @param expected - the counts the archive claims, `{total}`.
   * @returns what was read: how many memories this project has, how many the
   * database holds in total, and whether those match the manifest.
   */
  async verify(expected) {
    const wanted = Number.isFinite(expected?.total) ? expected.total : null;
    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    let reading = null;

    for (;;) {
      try {
        const total = await this.memory.countAll();
        const project = await this.memory.page({ page: 1, perPage: 1 });
        reading = {
          healthy: true,
          total,
          project_id: this.memory.projectId,
          project_total: project.total,
          expected_total: wanted,
          matches: wanted === null || wanted === total,
        };
        if (reading.matches) return reading;
      } catch (error) {
        // The sidecar may be mid-restart: a refused read is not a verdict,
        // it is one more reason to wait for the count to settle.
        reading = reading ?? {
          healthy: false,
          total: null,
          project_id: this.memory.projectId,
          project_total: null,
          expected_total: wanted,
          matches: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (Date.now() >= deadline) return reading;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  /**
   * Show the backups directory in the Finder.
   *
   * @returns the directory that was revealed.
   * @throws {PlatformError} when the directory is missing.
   */
  async reveal() {
    await revealDirectory(this.directory);
    return this.directory;
  }
}
