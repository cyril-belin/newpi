/**
 * The model router's plan: the configuration contract, validated.
 *
 * The plan is written by the user in the project's own `cordis.yml`, checked by
 * NewPi's Rust side before the harness starts, and carried to this plugin as one
 * JSON scalar in the launcher patch. It is checked again here, for the same
 * reason every NewPi plugin validates what it is handed: the row is also
 * loadable by hand, and a router that misreads its plan routes calls somewhere
 * nobody asked for.
 *
 * # The shape
 *
 * ```json
 * {
 *   "mode": "auto",
 *   "manual": { "provider": "…", "model": "…", "reasoningEffort": "…" },
 *   "active": { "provider": "…", "model": "…" },
 *   "roles": {
 *     "coding": {
 *       "provider": "…", "model": "…", "reasoningEffort": "…",
 *       "fallback": { "provider": "…", "model": "…" },
 *       "capabilities": { "tools": true, "vision": false, "maxContext": 64000 }
 *     }
 *   },
 *   "requirements": { "coding": { "tools": true, "maxContext": 64000 } }
 * }
 * ```
 *
 * The field is `reasoningEffort`, not `reasoning`, because that is the name the
 * harness's own `ModelSelection` uses; the YAML key the user writes is
 * `reasoning`, and the Rust side performs that one rename so no consumer has to.
 *
 * # What a plan never contains
 *
 * Credentials. A provider is named here, never authenticated: keys live in the
 * harness's settings and in the environment. A plan that carries anything
 * key-shaped is refused rather than ignored, because ignoring it would leave a
 * secret in a file the user believes is safe to share.
 *
 * @module newpi-plugin-model-router/plan
 */

/** The three modes, in the order the interface should offer them. */
export const MODES = Object.freeze(['manual', 'switch', 'auto']);

/** The role vocabulary. A role is a task, never a provider or a model. */
export const ROLES = Object.freeze([
  'fast',
  'coding',
  'reasoning',
  'research',
  'review',
  'default',
]);

/** The role every unmapped role resolves to. */
export const DEFAULT_ROLE = 'default';

/**
 * Keys anywhere in a plan that mean a credential was put in the wrong place.
 *
 * Compared against each lowercased key with `includes`, so `api_key`, `apiKey`
 * and `provider_token` all fail.
 */
export const SECRET_MARKERS = Object.freeze([
  'api_key',
  'apikey',
  'api-key',
  'token',
  'secret',
  'password',
  'credential',
]);

/** Raised for a plan that is not usable. */
export class PlanError extends Error {
  /**
   * @param message - human readable detail, naming the offending key.
   * @param code - stable machine-routable failure class.
   */
  constructor(message, code = 'MODEL_ROUTER_PLAN_INVALID') {
    super(message);
    this.name = 'PlanError';
    this.code = code;
  }
}

/**
 * Whether a value is a plain object (not null, not an array).
 *
 * @param value - the value to test.
 * @returns whether it is a plain object.
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Refuse a key the schema does not define, so a typo cannot be silently
 * ignored — a misspelled `fallback` is a route with no fallback at all.
 *
 * @param value - the object whose keys to check.
 * @param allowed - the keys this node accepts.
 * @param path - diagnostic path of the object.
 * @throws {PlanError} naming the first unknown key.
 */
function assertKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new PlanError(
        `${path}: unknown key ${JSON.stringify(key)}; expected one of ${allowed.join(', ')}`,
      );
    }
  }
}

/**
 * Refuse a credential-shaped key at any depth.
 *
 * @param value - the node to walk.
 * @param path - diagnostic path of the node.
 * @throws {PlanError} naming the key and where credentials do belong.
 */
function assertNoSecrets(value, path) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecrets(entry, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const lowered = key.toLowerCase();
    if (SECRET_MARKERS.some((marker) => lowered.includes(marker))) {
      throw new PlanError(
        `${path}.${key}: credentials do not belong in the routing plan; ` +
          'they are owned by the harness settings ($DSH_HOME/settings.yaml) and the environment',
      );
    }
    assertNoSecrets(child, `${path}.${key}`);
  }
}

/**
 * Read a non-empty string field.
 *
 * @param value - the object to read from.
 * @param key - the field name.
 * @param path - diagnostic path.
 * @param required - whether an absent field is an error.
 * @returns the string, or `undefined` when absent and optional.
 * @throws {PlanError} when present but not a non-empty string.
 */
function readString(value, key, path, required) {
  const raw = value[key];
  if (raw === undefined || raw === null) {
    if (required) throw new PlanError(`${path}.${key} is required`);
    return undefined;
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new PlanError(`${path}.${key} must be a non-empty string`);
  }
  return raw.trim();
}

/**
 * Normalize one `{ provider, model, reasoningEffort }` node.
 *
 * @param value - the raw node.
 * @param path - diagnostic path.
 * @returns a frozen selection with no absent keys set.
 * @throws {PlanError} when a field is missing or malformed.
 */
export function parseSelection(value, path) {
  if (!isObject(value)) {
    throw new PlanError(`${path} must be an object with a provider and a model`);
  }
  assertKeys(value, ['provider', 'model', 'reasoningEffort'], path);
  return readSelection(value, path);
}

/**
 * Read the three selection fields out of a node that may carry other keys too.
 *
 * A role node is the case: it holds a selection *and* a fallback and a
 * capability declaration, so the key check belongs to its caller.
 *
 * @param value - the raw node.
 * @param path - diagnostic path.
 * @returns the frozen selection.
 * @throws {PlanError} when a field is missing or malformed.
 */
function readSelection(value, path) {
  const selection = {
    provider: readString(value, 'provider', path, true),
    model: readString(value, 'model', path, true),
  };
  const effort = readString(value, 'reasoningEffort', path, false);
  if (effort !== undefined) selection.reasoningEffort = effort;
  return Object.freeze(selection);
}

/**
 * Normalize one capability node.
 *
 * Every field is optional and an absent one stays absent — *unknown*, never
 * `false`. That distinction is the whole point: a deployment that declares
 * nothing must not look like a deployment whose models cannot call tools.
 *
 * @param value - the raw node.
 * @param path - diagnostic path.
 * @returns a frozen capability object, or `undefined` when it declares nothing.
 * @throws {PlanError} when a field has the wrong type.
 */
export function parseCapabilities(value, path) {
  if (!isObject(value)) throw new PlanError(`${path} must be an object`);
  assertKeys(value, ['tools', 'reasoning', 'vision', 'maxContext'], path);
  const capabilities = {};
  for (const key of ['tools', 'reasoning', 'vision']) {
    const raw = value[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'boolean') {
      throw new PlanError(`${path}.${key} must be true or false`);
    }
    capabilities[key] = raw;
  }
  const maxContext = value.maxContext;
  if (maxContext !== undefined && maxContext !== null) {
    if (!Number.isInteger(maxContext) || maxContext <= 0) {
      throw new PlanError(`${path}.maxContext must be a positive whole number of tokens`);
    }
    capabilities.maxContext = maxContext;
  }
  return Object.keys(capabilities).length === 0 ? undefined : Object.freeze(capabilities);
}

/**
 * The selection fields of one parsed role route.
 *
 * A route carries its selection flattened alongside its fallback and its
 * capability declaration — that is the JSON contract the Rust side writes — so
 * this extracts exactly the triple a `ModelSelection` is, and nothing else.
 *
 * @param route - one `plan.roles.<role>` entry.
 * @returns the frozen `{ provider, model, reasoningEffort? }`.
 */
export function routeSelection(route) {
  const selection = { provider: route.provider, model: route.model };
  if (route.reasoningEffort !== undefined) selection.reasoningEffort = route.reasoningEffort;
  return Object.freeze(selection);
}

/**
 * Parse and validate one role's route.
 *
 * @param value - the raw route.
 * @param path - diagnostic path.
 * @returns a frozen `{ provider, model, reasoningEffort?, fallback?, capabilities? }`.
 * @throws {PlanError} when the route is malformed, or its fallback is itself.
 */
function parseRole(value, path) {
  if (!isObject(value)) throw new PlanError(`${path} must be an object`);
  assertKeys(
    value,
    ['provider', 'model', 'reasoningEffort', 'fallback', 'capabilities'],
    path,
  );
  const primary = readSelection(value, path);
  const route = { ...primary };

  if (value.fallback !== undefined && value.fallback !== null) {
    const fallback = parseSelection(value.fallback, `${path}.fallback`);
    if (fallback.provider === primary.provider && fallback.model === primary.model) {
      throw new PlanError(
        `${path}.fallback: a fallback to ${primary.provider} / ${primary.model} is the primary route; ` +
          'name a different provider or model, or remove it',
      );
    }
    route.fallback = fallback;
  }
  const capabilities = parseCapabilities(
    value.capabilities ?? {},
    `${path}.capabilities`,
  );
  if (capabilities !== undefined) route.capabilities = capabilities;
  return Object.freeze(route);
}

/**
 * Assert that a string is one of the router's roles.
 *
 * An unknown role is a caller's typo, not an unmapped role: silently answering
 * it with `default` would hide the bug for as long as nobody looks at the model
 * actually used.
 *
 * @param role - the requested role.
 * @returns the role.
 * @throws {PlanError} naming the vocabulary when the role is not in it.
 */
export function assertRole(role) {
  if (typeof role !== 'string' || !ROLES.includes(role)) {
    throw new PlanError(
      `unknown role ${JSON.stringify(role)}; use one of ${ROLES.join(', ')}`,
      'MODEL_ROUTER_UNKNOWN_ROLE',
    );
  }
  return role;
}

/**
 * Parse a plan.
 *
 * @param raw - the plan as the launcher patch carries it: a JSON string, or
 *   an already-decoded object.
 * @returns the frozen plan.
 * @throws {PlanError} when the plan is absent, unparsable, or invalid.
 */
export function parsePlan(raw) {
  let value = raw;
  if (typeof value === 'string') {
    if (value.trim() === '') {
      throw new PlanError('the model-router row carries an empty plan');
    }
    try {
      value = JSON.parse(value);
    } catch (error) {
      throw new PlanError(`the model-router plan is not valid JSON: ${error.message}`);
    }
  }
  if (!isObject(value)) {
    throw new PlanError('the model-router row carries no plan');
  }
  assertNoSecrets(value, 'plan');
  assertKeys(value, ['mode', 'manual', 'active', 'roles', 'requirements'], 'plan');

  const mode = readString(value, 'mode', 'plan', true);
  if (!MODES.includes(mode)) {
    throw new PlanError(
      `plan.mode: ${JSON.stringify(mode)} is not a mode; use ${MODES.join(', ')}`,
    );
  }

  const plan = { mode };
  if (value.manual !== undefined && value.manual !== null) {
    plan.manual = parseSelection(value.manual, 'plan.manual');
  }
  if (value.active !== undefined && value.active !== null) {
    plan.active = parseSelection(value.active, 'plan.active');
  }

  const roles = {};
  if (value.roles !== undefined && value.roles !== null) {
    if (!isObject(value.roles)) throw new PlanError('plan.roles must be an object');
    for (const [role, route] of Object.entries(value.roles)) {
      assertRole(role);
      roles[role] = parseRole(route, `plan.roles.${role}`);
    }
  }
  plan.roles = Object.freeze(roles);

  const requirements = {};
  if (value.requirements !== undefined && value.requirements !== null) {
    if (!isObject(value.requirements)) {
      throw new PlanError('plan.requirements must be an object');
    }
    for (const [role, declared] of Object.entries(value.requirements)) {
      assertRole(role);
      const capabilities = parseCapabilities(declared, `plan.requirements.${role}`);
      if (capabilities !== undefined) requirements[role] = capabilities;
    }
  }
  plan.requirements = Object.freeze(requirements);

  if (mode === 'manual' && plan.manual === undefined) {
    throw new PlanError('plan: mode "manual" requires a manual provider and model');
  }
  if (mode === 'switch' && plan.active === undefined) {
    throw new PlanError('plan: mode "switch" requires an active provider and model');
  }
  if (mode === 'auto' && roles[DEFAULT_ROLE] === undefined) {
    throw new PlanError(
      'plan: mode "auto" requires plan.roles.default, the route every unmapped role resolves to',
    );
  }

  return Object.freeze(plan);
}
