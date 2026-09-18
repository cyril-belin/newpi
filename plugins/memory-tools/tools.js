/**
 * The `remember`, `recall` and `forget` tool definitions.
 *
 * A tool here is a plain object in the registry's own shape: `name`,
 * `description`, a JSON Schema subset for `parameters`, an `output` pair, and
 * an `execute` body. Building them by hand rather than through `defineTool`
 * keeps this package importable with nothing but Cordis, which is what lets the
 * same code be unit tested outside a harness process.
 *
 * The schema dialect is the registry's enforced subset, and it has one sharp
 * edge worth naming: `required` is the standard JSON Schema *array of property
 * names* at the object node, not a per-property flag. Writing
 * `{ type: 'string', required: true }` inside `properties` is rejected by
 * `assertObjectJsonSchema`, so every object below declares its own `required`
 * array. Output schemas go through the stricter author DSL instead.
 *
 * Argument validation is therefore ours. Every schema constraint the model is
 * shown is re-checked in `assert*Args`, because the registry forwards what the
 * model sent and the parameters only describe it.
 *
 * @module newpi-plugin-memory-tools/tools
 */

import { MEMORY_KINDS, MemoryError, MAX_RECALL_LIMIT } from '../pocketbase-memory/core.js';

/** Shared JSON Schema fragment for a memory kind, so the tools cannot drift. */
const MEMORY_KIND_SCHEMA = {
  type: 'string',
  enum: [...MEMORY_KINDS],
};

/** Content shape the description asks for when a bug is closed. Documented as
 * data, not as a second tool: v1 keeps the agreed three tool signatures. */
const BUGFIX_SHAPE = 'Symptom / Confirmed cause / Fix / Proof';

/** One item of the `recall` output, shared by every memory-returning tool. */
const MEMORY_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'content', 'created_at'],
  properties: {
    id: { type: 'string', description: 'Opaque id, pass it to forget.' },
    kind: MEMORY_KIND_SCHEMA,
    content: { type: 'string' },
    created_at: { type: 'string', description: 'UTC timestamp.' },
  },
};

/**
 * Render one memory as a compact text block for the model.
 *
 * @param memory - the stored memory.
 * @returns the text block.
 */
function renderMemory(memory) {
  return `[${memory.kind}] ${memory.id} · ${memory.created_at}\n${memory.content}`;
}

/**
 * The durable-memory guidance shared by every tool description. It is the same
 * text in all three so the rule "record conclusions, not thoughts" is visible
 * whichever tool the model reaches for.
 */
const MEMORY_RULES =
  'The memory is per project and durable across sessions. Record conclusions, ' +
  'not activity: a convention the project follows, a decision and why it was made, ' +
  'a bug that was fixed together with its confirmed cause and its proof, or a lesson ' +
  `that would otherwise be relearned. For a resolved bug write ${BUGFIX_SHAPE}, ` +
  'each on its own line, and state the cause only once it is confirmed. Never store ' +
  'raw working thoughts, restatements of the current request, speculation, or a ' +
  'hypothesis that was not validated.';

/**
 * Build the `remember` tool.
 *
 * @param memory - the memory backend service.
 * @returns the tool definition.
 */
export function rememberTool(memory) {
  return {
    name: 'remember',
    description:
      `Save one durable fact about this project to its persistent memory. ${MEMORY_RULES} ` +
      'Call it as soon as a conclusion is settled, not at the end of the session.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['content', 'kind'],
      properties: {
        content: {
          type: 'string',
          description:
            'The fact itself, self contained enough to be useful with no other context. ' +
            `For a bugfix: "${BUGFIX_SHAPE.replaceAll(' / ', '\n')}".`,
        },
        kind: {
          ...MEMORY_KIND_SCHEMA,
          description:
            'note (context worth keeping) | decision (a choice and its reason) | ' +
            'bugfix (a resolved defect) | lesson (a rule learned the hard way).',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind', 'created_at'],
        properties: {
          id: { type: 'string' },
          kind: MEMORY_KIND_SCHEMA,
          created_at: { type: 'string' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `Remembered as ${value.kind} (${value.id}).` },
      ],
      presentationMeta: (_args, value) => ({ id: value.id, kind: value.kind }),
    },
    async execute(args) {
      assertRememberArgs(args);
      const stored = await memory.remember({ content: args.content, kind: args.kind });
      return { id: stored.id, kind: stored.kind, created_at: stored.created_at };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Remember (${typeof args?.kind === 'string' ? args.kind : 'memory'})`,
      kind: 'other',
      rawInput: args?.content ?? args,
    }),
  };
}

/**
 * Build the `recall` tool.
 *
 * @param memory - the memory backend service.
 * @returns the tool definition.
 */
export function recallTool(memory) {
  return {
    name: 'recall',
    description:
      'Search this project\'s persistent memory. Always scoped to the current project: ' +
      'other projects are not reachable from here. Use it before re-deriving a convention, ' +
      're-diagnosing a bug, or contradicting an earlier decision. With no query it returns ' +
      'the most recent memories. Plain substring matching, newest first — not semantic search.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description:
            'Text to look for in the memory content. Pass an empty string to list the newest memories.',
        },
        kind: {
          ...MEMORY_KIND_SCHEMA,
          description: 'Restrict to one kind. Omit to search every kind.',
        },
        limit: {
          type: 'integer',
          description: `Maximum memories to return, 1 to ${MAX_RECALL_LIMIT}. Defaults to 8.`,
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['memories', 'count'],
        properties: {
          memories: { type: 'array', items: MEMORY_ITEM_SCHEMA },
          count: { type: 'integer' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.count === 0
              ? 'No matching memory in this project.'
              : value.memories.map(renderMemory).join('\n\n'),
        },
      ],
      presentationMeta: (_args, value) => ({ count: value.count }),
    },
    async execute(args) {
      assertRecallArgs(args);
      const memories = await memory.recall({
        query: typeof args.query === 'string' ? args.query : '',
        kind: args.kind,
        limit: args.limit,
      });
      return {
        memories: memories.map((item) => ({
          id: item.id,
          kind: item.kind,
          content: item.content,
          created_at: item.created_at,
        })),
        count: memories.length,
      };
    },
    presentCall: (args) => ({
      card: 'generic',
      title:
        typeof args?.query === 'string' && args.query.length > 0
          ? `Recall "${args.query}"`
          : 'Recall recent memories',
      kind: 'other',
      rawInput: typeof args?.kind === 'string' ? { kind: args.kind } : undefined,
    }),
  };
}

/**
 * Build the `forget` tool.
 *
 * @param memory - the memory backend service.
 * @returns the tool definition.
 */
export function forgetTool(memory) {
  return {
    name: 'forget',
    description:
      'Delete one memory of this project by its id. Use it when a memory is wrong, ' +
      'superseded, or was written by mistake. Ids come from remember or recall results.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: {
          type: 'string',
          description: 'The id returned by remember or recall.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'deleted'],
        properties: {
          id: { type: 'string' },
          deleted: { type: 'boolean' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.deleted
            ? `Forgot ${value.id}.`
            : `No memory ${value.id} in this project; nothing was deleted.`,
        },
      ],
      presentationMeta: (_args, value) => ({ deleted: value.deleted }),
    },
    async execute(args) {
      assertForgetArgs(args);
      const deleted = await memory.forget(args.id);
      return { id: args.id, deleted };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Forget memory',
      kind: 'other',
      rawInput: args?.id ?? args,
    }),
  };
}

/**
 * Build the whole provider surface.
 *
 * @param memory - the memory backend service.
 * @returns the three tool definitions, in the order they are registered.
 */
export function memoryTools(memory) {
  return [rememberTool(memory), recallTool(memory), forgetTool(memory)];
}

/** Reject anything the `remember` schema describes but does not enforce. */
function assertRememberArgs(args) {
  if (args === null || typeof args !== 'object') {
    throw new MemoryError('MEMORY_INVALID_ARGS', 'remember expects an object of arguments');
  }
  if (!MEMORY_KINDS.includes(args.kind)) {
    throw new MemoryError(
      'MEMORY_INVALID_KIND',
      `kind must be one of ${MEMORY_KINDS.join(', ')}`,
    );
  }
  if (typeof args.content !== 'string') {
    throw new MemoryError('MEMORY_EMPTY_CONTENT', 'content must be a string');
  }
}

/** Reject anything the `recall` schema describes but does not enforce. */
function assertRecallArgs(args) {
  if (args === null || typeof args !== 'object') {
    throw new MemoryError('MEMORY_INVALID_ARGS', 'recall expects an object of arguments');
  }
  if (args.query !== undefined && typeof args.query !== 'string') {
    throw new MemoryError('MEMORY_INVALID_ARGS', 'query must be a string');
  }
  if (args.kind !== undefined && !MEMORY_KINDS.includes(args.kind)) {
    throw new MemoryError(
      'MEMORY_INVALID_KIND',
      `kind must be one of ${MEMORY_KINDS.join(', ')}`,
    );
  }
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1)) {
    throw new MemoryError('MEMORY_INVALID_LIMIT', 'limit must be a positive integer');
  }
}

/** Reject anything the `forget` schema describes but does not enforce. */
function assertForgetArgs(args) {
  if (args === null || typeof args !== 'object') {
    throw new MemoryError('MEMORY_INVALID_ARGS', 'forget expects an object of arguments');
  }
  if (typeof args.id !== 'string' || args.id.trim().length === 0) {
    throw new MemoryError('MEMORY_INVALID_ID', 'id must be a non-empty string');
  }
}
