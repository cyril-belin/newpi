/**
 * NewPi's branding plugin: the wordmark, the mark, and the tab title.
 *
 * Three pieces of the interface carry the engine's name or its artwork, and
 * NewPi owns none of them on disk:
 *
 * 1. The document `<title>`, which the host webserver renders and exposes
 *    through `tapIndex` — the documented escape hatch for markup no structured
 *    injection row expresses. NewPi replaces exactly that one element.
 *
 * 2. The sidebar wordmark. The engine draws it as an inline SVG `<path>` whose
 *    outline *is* the name, so there is no string to substitute and no
 *    configuration slot: the brand plugin registers a component whose whole
 *    body is that artwork. What the client does expose is
 *    `data-slot="sidebar.brand.name"` on the element wrapping it.
 *
 * 3. The mark beside it, under `data-slot="sidebar.brand.mark"`.
 *
 * Both slots are therefore replaced rather than configured: a rule scoped to
 * each slot hides the engine's artwork, and NewPi's own whale is placed in the
 * mark slot by pointing an `<img>` at a route this plugin serves. The route
 * serves `assets/whale.svg` — the same file the repository ships — so the mark
 * is not copied into this source and a change to the SVG is a change to the
 * interface, with nothing to keep in sync.
 *
 * Nothing is written to the engine's files, so an engine upgrade replaces its
 * artwork and this keeps working against the new one. The script is a
 * progressive enhancement: if a future engine renames a slot, it does nothing
 * and the interface keeps its stock appearance. It never throws into the page,
 * and it never removes a node the framework owns.
 *
 * @module newpi-plugin-brand
 */

/** Plugin name, matching the row id NewPi writes into its launcher patch. */
export const name = 'newpi-brand';

/** The webserver that renders the interface and serves the mark. */
export const inject = ['webServer'];

/** The product name every NewPi surface shows. */
export const PRODUCT_NAME = 'NewPi';

/** Route the whale artwork is served from. The extension is kept so a browser
 * treats the response as an image on its own. */
export const WHALE_ROUTE = '/newpi/whale.svg';

/** `<title>` and its content, however the engine spaces it. */
const TITLE = /<title(?:\s[^>]*)?>[\s\S]*?<\/title>/i;

/** The slot the sidebar wraps its wordmark in. */
export const WORDMARK_SLOT = 'sidebar.brand.name';

/** The slot the sidebar wraps its mark in. */
export const MARK_SLOT = 'sidebar.brand.mark';

/**
 * Replace the document's title with NewPi's.
 *
 * A pure function of its input, as `tapIndex` requires: no state, no clock, no
 * I/O. It is a no-op on a document with no `<title>`, so a future engine that
 * drops the element cannot make this plugin fail a request.
 *
 * @param html - the rendered `index.html` body.
 * @returns the body with exactly one title element, renamed.
 */
export function renameTitle(html) {
  if (!TITLE.test(html)) return html;
  // `replace` with a string pattern would reinterpret `$` sequences in the
  // replacement; the function form keeps the name literal.
  return html.replace(TITLE, () => `<title>${PRODUCT_NAME}</title>`);
}

/**
 * The branding styling.
 *
 * Every selector is anchored on a slot attribute, so nothing here can reach any
 * other part of the interface, and colours are inherited so the result follows
 * whichever theme is active.
 *
 * @returns the CSS text.
 */
function brandStyle() {
  return [
    // The sidebar lays both slots out in a row; the margin replaces the
    // spacing the engine put between its own mark and wordmark.
    `[data-slot="${MARK_SLOT}"],[data-slot="${WORDMARK_SLOT}"]{display:flex;align-items:center;}`,
    `[data-slot="${MARK_SLOT}"]{margin-right:8px;flex:0 0 auto;}`,
    // The engine's artwork, hidden through its own slot wrapper only.
    `[data-slot="${MARK_SLOT}"]>svg,[data-slot="${WORDMARK_SLOT}"]>svg{display:none;}`,
    // NewPi's mark. The engine reserved 24px for its own artwork, but the
    // sidebar mark carries a pi inside a whale and the extra 4px is what makes
    // that legible; the row is laid out with room for it.
    '.newpi-mark{display:block;width:28px;height:28px;}',
    '.newpi-mark>img{display:block;width:100%;height:100%;}',
    '.newpi-wordmark{font:600 15px/1 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;',
    'letter-spacing:.01em;color:inherit;white-space:nowrap;}',
  ].join('');
}

/**
 * The script that keeps the title and fills both sidebar slots.
 *
 * Written as a string because it has to run in the page, and deliberately
 * defensive: a missing or renamed slot is a silent no-op rather than an error
 * in somebody's console.
 *
 * The title needs both halves. The tap renames `<title>` in the served HTML,
 * which is what the window and the tab show before any script runs, but the
 * client renames the document again once it boots — measured: the served HTML
 * said `NewPi` while `document.title` said the engine's name a few seconds
 * later. So the script re-runs the rename, then replaces the `title` accessor
 * so a later write resolves to the same value instead of overwriting it. Only
 * that one accessor is touched.
 *
 * @param title - the product name to enforce.
 * @param whaleRoute - the route the mark is served from.
 * @returns the script body, without its `<script>` wrapper.
 */
function brandScript(title, whaleRoute) {
  return `(function(){
var MARK=${JSON.stringify(MARK_SLOT)},NAME=${JSON.stringify(WORDMARK_SLOT)};
var TITLE=${JSON.stringify(title)},WHALE=${JSON.stringify(whaleRoute)};
var MARK_CLASS='newpi-mark',NAME_CLASS='newpi-wordmark';
function fixTitle(){
  var el=document.querySelector('title');
  if(el&&el.textContent!==TITLE)el.textContent=TITLE;
}
function lockTitle(){
  try{
    var proto=Object.getPrototypeOf(document);
    var descriptor=Object.getOwnPropertyDescriptor(proto,'title');
    if(descriptor&&descriptor.set&&descriptor.get){
      Object.defineProperty(document,'title',{configurable:true,
        get:function(){return TITLE;},
        set:function(){fixTitle();}});
    }
  }catch(error){/* a locked document keeps the tap's rename */}
  fixTitle();
}
function slotFor(name){
  return document.querySelector('[data-slot="'+name+'"]');
}
function fill(slot,className,build){
  if(!slot)return false;
  if(slot.querySelector('.'+className))return true;
  var node=build();
  if(node)slot.appendChild(node);
  return true;
}
function fixMark(){
  var slot=slotFor(MARK);
  if(!slot)return false;
  return fill(slot,MARK_CLASS,function(){
    var box=document.createElement('span');
    box.className=MARK_CLASS;
    var image=document.createElement('img');
    image.src=WHALE;
    image.alt='';
    image.setAttribute('aria-hidden','true');
    box.appendChild(image);
    return box;
  });
}
function fixName(){
  var slot=slotFor(NAME);
  if(!slot)return false;
  return fill(slot,NAME_CLASS,function(){
    var label=document.createElement('span');
    label.className=NAME_CLASS;
    label.textContent=TITLE;
    return label;
  });
}
function tick(){
  fixTitle();
  var mark=fixMark(),name=fixName();
  return mark&&name;
}
if(!tick()){
  var watcher=new MutationObserver(function(){if(tick())watcher.disconnect();});
  watcher.observe(document.documentElement,{childList:true,subtree:true});
  window.addEventListener('load',function(){tick();});
  // A slot that never appears must not keep this observer running on every
  // mutation of the page for the rest of the session: give up after a few
  // seconds, the same way the console's own fallback does.
  setTimeout(function(){watcher.disconnect();},4000);
}
lockTitle();
})();`;
}

/**
 * Inject the style and the script into the document head.
 *
 * @param html - the rendered `index.html` body.
 * @param whaleRoute - the route the mark is served from.
 * @returns the body with the branding additions.
 */
export function installWordmark(html, whaleRoute = WHALE_ROUTE) {
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  const markup =
    `<style data-newpi="brand">${brandStyle()}</style>` +
    `<script data-newpi="brand">${brandScript(PRODUCT_NAME, whaleRoute)}</script>`;
  if (head === null) return `${markup}${html}`;
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}${markup}${html.slice(at)}`;
}

/**
 * Apply every branding transform, in order.
 *
 * @param html - the rendered `index.html` body.
 * @param whaleRoute - the route the mark is served from.
 * @returns the branded body.
 */
export function brand(html, whaleRoute = WHALE_ROUTE) {
  return installWordmark(renameTitle(html), whaleRoute);
}

/**
 * Register the branding tap, and serve the mark it refers to.
 *
 * One tap for both transforms keeps the ordering explicit: the title is renamed
 * first, then the head additions are spliced in.
 *
 * @param ctx - the owning Cordis context, carrying `webServer`.
 * @param config - the plugin row's configuration.
 * @param config.whale - the whale artwork. The application embeds it so the file
 *   on disk stays the only copy; a hand-written row may omit it, and then the
 *   mark slot is left untouched.
 */
export function apply(ctx, config = {}) {
  const whale = typeof config.whale === 'string' ? config.whale : '';

  if (whale.length > 0) {
    ctx.webServer.register({
      kind: 'exact',
      path: WHALE_ROUTE,
      handler: (_request, response) => {
        const body = Buffer.from(whale, 'utf8');
        response.writeHead(200, {
          'content-type': 'image/svg+xml; charset=utf-8',
          'content-length': String(body.byteLength),
          // Local content on the interface's own origin, and small enough that
          // caching it would only risk serving a stale mark after an update.
          'cache-control': 'no-store',
        });
        response.end(body);
      },
    });
  }

  ctx.webServer.tapIndex((html) => brand(html, WHALE_ROUTE));
  ctx.logger.info(
    whale.length > 0
      ? `${name}: ${PRODUCT_NAME} title, wordmark and mark installed`
      : `${name}: ${PRODUCT_NAME} title and wordmark installed (no mark artwork)`,
  );
}
