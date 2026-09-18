// Rasterizes the NewPi logo for the application icon.
//
// `assets/logo.svg` is the source of truth for the mark: it is the artwork the
// application ships, and the generated PNG is a build product of it. Deriving
// the PNG rather than drawing it means the icon cannot drift from the logo a
// designer hands over, and re-running this after replacing the SVG is the whole
// update procedure.
//
// The rasterizer is a real browser engine, because the logo is not a shape this
// script could reasonably re-draw: it carries two linear gradients, an inner
// stroke, and a Gaussian glow, and a hand-rolled rasterizer would approximate
// all four. A browser renders it exactly as it renders everywhere else.
//
// `pnpm icon` runs this and then hands the PNG to the Tauri CLI, which derives
// every platform size from it. The engine is only needed for that one step, so
// it is looked up rather than required: a checkout that never rebuilds the icon
// needs nothing installed.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Edge length of the source PNG. The Tauri CLI downsamples from here. */
const SIZE = 1024;

/** Where the logo lives, relative to this script. */
const LOGO = '../assets/logo.svg';

/** Where the Tauri CLI expects the source PNG. */
const OUTPUT = '../assets/icon-source.png';

/**
 * Locate a Chromium Playwright already downloaded.
 *
 * The version suffix changes whenever the Playwright that fetched it is
 * upgraded, so the directory is matched by prefix instead of by an exact name,
 * and the newest match wins.
 *
 * @returns the executable path, or `null` when none is installed.
 */
function findChromium() {
  const cache = join(
    process.env.HOME ?? '',
    'Library/Caches/ms-playwright',
  );
  if (!existsSync(cache)) return null;

  const candidates = readdirSync(cache)
    .filter((entry) => entry.startsWith('chromium') && entry.includes('-'))
    .sort()
    .reverse();

  for (const entry of candidates) {
    const base = join(cache, entry);
    const paths = [
      join(base, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
      join(base, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      join(base, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ];
    for (const path of paths) {
      if (existsSync(path)) return path;
    }
  }
  return null;
}

/**
 * Import the Playwright library installed beside a Chromium download.
 *
 * @returns the library, or `null` when it is not available.
 */
async function findPlaywright() {
  const roots = [
    join(process.env.HOME ?? '', '.npm/_npx'),
    join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules'),
  ];
  const candidates = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    if (root.endsWith('node_modules')) {
      candidates.push(join(root, 'playwright'));
      continue;
    }
    for (const entry of readdirSync(root)) {
      candidates.push(join(root, entry, 'node_modules', 'playwright'));
    }
  }
  for (const candidate of candidates) {
    const entry = join(candidate, 'index.mjs');
    if (existsSync(entry)) return import(entry);
  }
  return null;
}

/**
 * Render the logo to a square PNG with its own transparency preserved.
 *
 * @param svg - the logo's markup.
 * @param executablePath - the browser to render with.
 * @returns the PNG bytes.
 */
async function render(svg, executablePath, playwright) {
  const browser = await playwright.chromium.launch({ executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
    // The SVG is inlined rather than navigated to, so the page owns a normal
    // document and the capture can drop the background entirely.
    await page.setContent(
      '<!doctype html><html><head><style>'
        + 'html,body{margin:0;padding:0;background:transparent;}'
        + `svg{display:block;width:${SIZE}px;height:${SIZE}px;}`
        + `</style></head><body>${svg}</body></html>`,
    );
    return await page.locator('svg').screenshot({ omitBackground: true });
  } finally {
    await browser.close();
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const logoPath = resolve(here, LOGO);
const output = resolve(here, OUTPUT);
const svg = readFileSync(logoPath, 'utf8');

const executablePath = findChromium();
const playwright = executablePath === null ? null : await findPlaywright();

if (executablePath === null || playwright === null) {
  console.error(
    'NewPi icon: no rendering engine found.\n'
      + `  The logo at ${LOGO} has to be rasterized to ${OUTPUT}.\n`
      + '  Install Playwright once with `npx playwright install chromium`, then run `pnpm icon` again.\n'
      + '  A checkout that does not rebuild the icon needs none of this.',
  );
  process.exit(1);
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, await render(svg, executablePath, playwright));
console.log(`NewPi icon: wrote ${OUTPUT} (${SIZE}x${SIZE}) from ${LOGO}`);
