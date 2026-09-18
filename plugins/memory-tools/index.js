/**
 * Cordis provider that exposes the project memory to the model.
 *
 * `inject = ['tools', 'pocketbaseMemory']` is the whole contract: this plugin
 * waits for the tool registry and the memory backend, then registers
 * `remember`, `recall` and `forget` on the registry. It owns no connection and
 * no storage — every call is delegated to `@deepseek-ai/...`'s sibling
 * `newpi-plugin-pocketbase-memory`.
 *
 * `project_id` is intentionally absent from all three tool schemas. The scope
 * is fixed by the project's own configuration before the harness starts, so
 * there is no argument an agent could supply to reach another project's
 * memory.
 *
 * @module newpi-plugin-memory-tools
 */

import { memoryTools } from './tools.js';

/** Plugin name, matching the row id NewPi writes into its launcher patch. */
export const name = 'memory-tools';

/** The tool registry and the memory backend, in that order. */
export const inject = ['tools', 'pocketbaseMemory'];

/** Keywords the registry's enforced JSON Schema subset accepts. */
const SCHEMA_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
]);

/** Scalar types the subset accepts. */
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/**
 * Check one schema node against the registry's enforced subset.
 *
 * This mirrors `assertSupportedJsonSchema` from `@deepseek-ai/dsh-tools`
 * instead of importing it, so this package stays loadable with nothing but
 * Cordis. That is not stylistic: the harness resolves a bare `@deepseek-ai/...`
 * specifier from the profile's module tree, and a plugin deployed outside it
 * would fail to import at boot. Keeping the check here means the failure mode
 * of a drifted schema is a clear message from this file, at the same moment,
 * with no extra resolution requirement.
 *
 * @param schema - the node to check.
 * @param path - diagnostic path used in messages.
 * @param violations - collector for every problem found.
 */
function checkSchemaNode(schema, path, violations) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    violations.push(`${path} must be a schema object`);
    return;
  }
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYWORDS.has(key)) {
      violations.push(`${path}.${key} is not a supported keyword`);
    }
  }
  if (Object.hasOwn(schema, 'type')) {
    if (!SCHEMA_TYPES.has(schema.type)) {
      violations.push(`${path}.type must be one of ${[...SCHEMA_TYPES].join(', ')}`);
    }
  }
  if (Object.hasOwn(schema, 'required')) {
    const required = schema.required;
    if (!Array.isArray(required) || required.some((entry) => typeof entry !== 'string')) {
      violations.push(`${path}.required must be an array of property names`);
    } else {
      for (const key of required) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) {
          violations.push(`${path}.required names "${key}" which is not in properties`);
        }
      }
    }
  }
  if (Object.hasOwn(schema, 'additionalProperties') && typeof schema.additionalProperties !== 'boolean') {
    violations.push(`${path}.additionalProperties must be a boolean`);
  }
  if (Object.hasOwn(schema, 'enum') && !Array.isArray(schema.enum)) {
    violations.push(`${path}.enum must be an array`);
  }
  if (Object.hasOwn(schema, 'oneOf')) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0) {
      violations.push(`${path}.oneOf must be a non-empty array`);
    } else {
      schema.oneOf.forEach((branch, index) => {
        checkSchemaNode(branch, `${path}.oneOf[${index}]`, violations);
      });
    }
  }
  if (Object.hasOwn(schema, 'properties')) {
    if (schema.properties === null || typeof schema.properties !== 'object') {
      violations.push(`${path}.properties must be an object`);
    } else {
      for (const [key, child] of Object.entries(schema.properties)) {
        checkSchemaNode(child, `${path}.properties.${key}`, violations);
      }
    }
  }
  if (Object.hasOwn(schema, 'items')) {
    checkSchemaNode(schema.items, `${path}.items`, violations);
  }
}

/**
 * Assert one object-rooted schema node, throwing the first batch of problems.
 *
 * @param schema - the schema to assert.
 * @param label - the tool name, so the message says which tool is at fault.
 */
function assertSchema(schema, label) {
  const violations = [];
  checkSchemaNode(schema, 'schema', violations);
  if (violations.length === 0 && schema.type !== 'object') {
    violations.push('schema.type must be "object"');
  }
  if (violations.length > 0) {
    throw new Error(`${name}: ${label} declares an unsupported JSON schema: ${violations.join('; ')}`);
  }
}

/**
 * Register the memory tools on `ctx.tools`.
 *
 * Both services are read as properties, which is what `inject` buys: Cordis
 * installs an accessor for every declared injection and resolves the property
 * through it. `ctx.get(name)` is the *uninjected* reader — its default strict
 * check returns `undefined` for a service whose providing fiber is not in the
 * running state, and reading an undeclared name as a property throws "cannot
 * get property ... without inject". Property access on a declared injection is
 * therefore the correct reader here, and the guards below turn a composition
 * mistake into a named error instead of a `TypeError` on `undefined`.
 *
 * Each definition is checked against the registry's schema subset first, so a
 * drifted schema names the tool and the offending keyword instead of surfacing
 * as an opaque registry error.
 *
 * The disposers the registry returns are not collected by hand: registration is
 * an effect on the owning fiber, so unloading this plugin removes its tools.
 *
 * @param ctx - the owning Cordis context, carrying `tools` and `pocketbaseMemory`.
 */
export function apply(ctx) {
  const memory = ctx.pocketbaseMemory;
  if (memory === undefined) {
    throw new Error(`${name}: the pocketbase-memory service is not mounted`);
  }
  const registry = ctx.tools;
  if (registry === undefined) {
    throw new Error(`${name}: the tool registry service is not mounted`);
  }
  for (const tool of memoryTools(memory)) {
    assertSchema(tool.parameters, `${tool.name}.parameters`);
    assertSchema(tool.output.schema, `${tool.name}.output`);
    registry.register(tool);
  }
  ctx.logger.info(`${name}: registered remember, recall, forget for project ${memory.projectId}`);
}
