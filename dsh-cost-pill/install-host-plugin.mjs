#!/usr/bin/env node
/**
 * install-host-plugin.mjs — deploy the `cost` session projection into the DSH
 * web profile.
 *
 * The workspace copy under `host-plugin/` is the source of truth; this script
 * is the deployment step:
 *   1. copies the plugin to `<profile>/plugins/dsh-cost-projection/`,
 *   2. links it into `<profile>/node_modules/` so the Loader resolves the bare
 *      name `dsh-cost-projection`,
 *   3. declares it in the profile's `package.json` (a later `pnpm install`
 *      keeps it),
 *   4. mounts it with one `insert` row in `<profile>/cordis.patch.yml` — the
 *      profile watches that file, so a running `dsh web` picks it up live.
 *
 * Usage:
 *   node install-host-plugin.mjs            # deploy / sync
 *   node install-host-plugin.mjs --check    # report drift, change nothing
 *   node install-host-plugin.mjs --remove   # unmount and undeploy
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, 'host-plugin');
const PRICES = join(HERE, 'prices.json');
const PROFILE = join(homedir(), '.dsh/profiles/web');
const DEPLOY = join(PROFILE, 'plugins/dsh-cost-projection');
const LINK = join(PROFILE, 'node_modules/dsh-cost-projection');
const PATCH = join(PROFILE, 'cordis.patch.yml');
const PROFILE_PKG = join(PROFILE, 'package.json');
const PLUGIN_NAME = 'dsh-cost-projection';
const ENTRY_ID = 'cost-projection';
const MARK_START = '# --- dsh-cost-projection (managed by dsh-cost-pill/install-host-plugin.mjs) ---';
const MARK_END = '# --- end dsh-cost-projection ---';

const CHECK = process.argv.includes('--check');
const REMOVE = process.argv.includes('--remove');
const mode = CHECK ? 'check' : REMOVE ? 'remove' : 'install';

/** The insert block mounting the projection, with the price-table path. */
function block() {
	return `${MARK_START}\n- insert:\n    - id: ${ENTRY_ID}\n      name: ${PLUGIN_NAME}\n      config:\n        pricesPath: ${PRICES}\n${MARK_END}`;
}

/** Patch file text with the block present (idempotent). */
function withBlock(text) {
	if (text.includes(MARK_START)) return text;
	const withoutPlaceholder = text.replace(/^\[\]\s*$/m, '');
	const trimmed = withoutPlaceholder.replace(/\s*$/, '');
	return `${trimmed === '' ? '' : `${trimmed}\n`}${block()}\n`;
}

/** Patch file text with the block removed. */
function withoutBlock(text) {
	const start = text.indexOf(MARK_START);
	if (start === -1) return text;
	const end = text.indexOf(MARK_END, start);
	const after = end === -1 ? '' : text.slice(end + MARK_END.length);
	const before = text.slice(0, start).replace(/\s*$/, '');
	const rest = after.replace(/^\s*\n?/, '');
	const joined = `${before === '' ? '' : `${before}\n`}${rest}`;
	return joined.trim() === '' ? '[]\n' : joined;
}

/** Drift report for the deployed copy versus the source. */
function drift() {
	const problems = [];
	for (const relative of ['package.json', 'lib/index.js']) {
		const from = join(SOURCE, relative);
		const to = join(DEPLOY, relative);
		if (!existsSync(to)) problems.push(`missing deployed file: ${relative}`);
		else if (readFileSync(from, 'utf8') !== readFileSync(to, 'utf8')) problems.push(`deployed file differs: ${relative}`);
	}
	if (!existsSync(LINK)) problems.push('profile node_modules link missing');
	else if (readlinkSync(LINK) !== `../plugins/${PLUGIN_NAME}`) problems.push(`link target is ${readlinkSync(LINK)}`);
	const patch = existsSync(PATCH) ? readFileSync(PATCH, 'utf8') : '';
	if (!patch.includes(MARK_START)) problems.push('cordis.patch.yml has no mount row');
	else if (!patch.includes(`pricesPath: ${PRICES}`)) problems.push('mount row points at another prices.json');
	const pkg = existsSync(PROFILE_PKG) ? JSON.parse(readFileSync(PROFILE_PKG, 'utf8')) : {};
	if (pkg.dependencies?.[PLUGIN_NAME] !== `file:plugins/${PLUGIN_NAME}`) problems.push('profile package.json does not declare the plugin');
	return problems;
}

if (!existsSync(SOURCE) || !existsSync(join(SOURCE, 'lib/index.js'))) {
	console.error(`plugin source missing: ${SOURCE}`);
	process.exit(1);
}
if (!existsSync(PROFILE)) {
	console.error(`DSH web profile missing: ${PROFILE}`);
	process.exit(1);
}

if (mode === 'check') {
	const problems = drift();
	if (problems.length === 0) {
		console.log(`ok    ${PLUGIN_NAME} deployed and mounted (prices: ${PRICES})`);
	} else {
		for (const problem of problems) console.log(`DRIFT ${problem}`);
	}
	process.exit(problems.length === 0 ? 0 : 1);
}

if (mode === 'remove') {
	if (existsSync(LINK)) rmSync(LINK, { recursive: true, force: true });
	if (existsSync(DEPLOY)) rmSync(DEPLOY, { recursive: true, force: true });
	if (existsSync(PATCH)) writeFileSync(PATCH, withoutBlock(readFileSync(PATCH, 'utf8')));
	if (existsSync(PROFILE_PKG)) {
		const pkg = JSON.parse(readFileSync(PROFILE_PKG, 'utf8'));
		if (pkg.dependencies !== undefined) delete pkg.dependencies[PLUGIN_NAME];
		writeFileSync(PROFILE_PKG, `${JSON.stringify(pkg, null, 2)}\n`);
	}
	console.log(`removed ${PLUGIN_NAME} from ${PROFILE}`);
	process.exit(0);
}

/* install ------------------------------------------------------------------ */

rmSync(DEPLOY, { recursive: true, force: true });
mkdirSync(dirname(DEPLOY), { recursive: true });
cpSync(SOURCE, DEPLOY, { recursive: true });
console.log(`deployed ${SOURCE} → ${DEPLOY}`);

if (existsSync(LINK)) rmSync(LINK, { recursive: true, force: true });
mkdirSync(dirname(LINK), { recursive: true });
symlinkSync(`../plugins/${PLUGIN_NAME}`, LINK);
console.log(`linked   node_modules/${PLUGIN_NAME} → ../plugins/${PLUGIN_NAME}`);

const pkg = JSON.parse(readFileSync(PROFILE_PKG, 'utf8'));
pkg.dependencies = { ...(pkg.dependencies ?? {}), [PLUGIN_NAME]: `file:plugins/${PLUGIN_NAME}` };
writeFileSync(PROFILE_PKG, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`declared dependencies.${PLUGIN_NAME} in the profile package.json`);

const patch = readFileSync(PATCH, 'utf8');
const patched = withBlock(patch);
if (patched !== patch) {
	writeFileSync(PATCH, patched);
	console.log(`mounted  insert row in ${PATCH.replace(homedir(), '~')}`);
} else {
	console.log('mount    insert row already present');
}

const problems = drift();
if (problems.length > 0) {
	for (const problem of problems) console.error(`DRIFT ${problem}`);
	process.exit(1);
}
console.log('\nprofile watches cordis.patch.yml, so a running `dsh web` reloads it live;');
console.log('reload the browser page to see the `cost` projection.');
