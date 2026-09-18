/**
 * The PocketBase sidecar's loopback coordinates.
 *
 * NewPi starts the sidecar before the harness and appends a
 * `--patch` overlay that mounts these two plugins. The overlay carries only
 * the project scope: the backend URL and the credential travel in the
 * harness's environment, so they never enter a document the harness reads
 * back or the user edits.
 *
 * Every key is read once, at plugin load, and the connection is verified on
 * first use. A sidecar that is missing is therefore reported by the first
 * `recall` rather than by a refusal to boot.
 *
 * @module newpi-plugin-pocketbase-memory/environment
 */

/** Environment variable holding the loopback base URL, e.g. `http://127.0.0.1:54001`. */
export const ENV_URL = 'DSH_MEMORY_URL';

/** Environment variable holding the superuser identity. */
export const ENV_IDENTITY = 'DSH_MEMORY_IDENTITY';

/** Environment variable holding the superuser password. */
export const ENV_PASSWORD = 'DSH_MEMORY_PASSWORD';

/** Environment variable holding the project scope. */
export const ENV_PROJECT_ID = 'DSH_MEMORY_PROJECT_ID';

/** Port used only when nothing in the environment names one. It exists so a
 * hand launched harness can reach a conventionally started PocketBase; NewPi
 * always passes a real port, chosen at launch. */
const FALLBACK_PORT = 8090;

/**
 * Read one setting: explicit plugin configuration first, then the environment.
 *
 * @param fromConfig - the configured value, if any.
 * @param envName - the environment variable to fall back to.
 * @param fallback - the value used when neither is present.
 * @returns the resolved string, or the fallback.
 */
export function setting(fromConfig, envName, fallback = '') {
  if (typeof fromConfig === 'string' && fromConfig.length > 0) return fromConfig;
  const fromEnv = process.env[envName];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return fallback;
}

/**
 * Resolve the loopback base URL.
 *
 * @param configured - the `url` setting, if any.
 * @returns a base URL with no trailing slash.
 */
export function resolveBaseUrl(configured) {
  const explicit = setting(configured, ENV_URL);
  if (explicit !== '') {
    return explicit.replace(/\/+$/, '');
  }
  const port = Number.parseInt(setting(undefined, 'DSH_MEMORY_PORT', String(FALLBACK_PORT)), 10);
  const safe = Number.isInteger(port) && port > 0 && port < 65536 ? port : FALLBACK_PORT;
  return `http://127.0.0.1:${safe}`;
}
