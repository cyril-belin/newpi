/// <reference path="../pb_data/types.d.ts" />
/**
 * Create the `memories` collection: the one durable store behind NewPi's
 * project memory.
 *
 * Shape, and why:
 *
 * - `content` holds the memory text. `min: 1` rejects an empty write at the
 *   database boundary, not only in the tool that usually guards it.
 * - `project_id` is the scope. Every read and every write the harness performs
 *   carries it, and it comes from the project's own `cordis.yml`, never from a
 *   tool argument. One collection serves every project; this column is what
 *   keeps them apart.
 * - `kind` is the memory class: note, decision, bugfix, lesson. It is a plain
 *   text field rather than a select because the vocabulary is enforced by the
 *   plugin, which must be able to answer with a clear message rather than a
 *   generic validation error. The migration and
 *   `plugins/pocketbase-memory/core.js` list the same four values.
 * - `created_at` is an autodate set once on create, so it is the memory's
 *   timestamp and not a last-touch time. `updated_at` is kept for PocketBase's
 *   own bookkeeping; nothing in v1 updates a memory in place — a correction is
 *   a new memory plus a `forget`.
 *
 * Indexes:
 *
 * - `(project_id, kind)` serves every scoped read and the kind filter.
 * - `(project_id, created_at DESC)` serves the default "newest first" listing
 *   and the scoped text search, which filters on `project_id` first.
 *
 * The API rules are all `null`, which means "superusers only". The harness
 * authenticates as the local superuser NewPi provisions, and nothing else —
 * not another local process, not the dashboard without that credential — can
 * read or write a memory.
 *
 * This file is versioned and applied by PocketBase's own migration runner
 * (`pocketbase serve` applies pending migrations at startup). It is never
 * edited after release: a change to the shape is a new migration file.
 */
migrate((app) => {
  const collection = new Collection({
    type: 'base',
    name: 'memories',
    fields: [
      {
        name: 'content',
        type: 'text',
        required: true,
        min: 1,
        max: 100000,
      },
      {
        name: 'project_id',
        type: 'text',
        required: true,
        min: 1,
        max: 200,
      },
      {
        name: 'kind',
        type: 'text',
        required: true,
        min: 1,
        max: 32,
      },
      {
        name: 'created_at',
        type: 'autodate',
        onCreate: true,
        onUpdate: false,
      },
      {
        name: 'updated_at',
        type: 'autodate',
        onCreate: true,
        onUpdate: true,
      },
    ],
    indexes: [
      'CREATE INDEX `idx_memories_project_kind` ON `memories` (`project_id`, `kind`)',
      'CREATE INDEX `idx_memories_project_created` ON `memories` (`project_id`, `created_at` DESC)',
    ],
    // Superusers only. `null` is PocketBase's "no rule", which denies every
    // non-superuser request.
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
  });

  app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId('memories');
  app.delete(collection);
});
