/**
 * The console panel's client code.
 *
 * The client below is a real function, not a string: it is syntax-checked with
 * the rest of the plugin, run against a fake DOM in the test suite, and
 * serialised into the page with `Function.prototype.toString`. Five rules it
 * keeps, the same ones every NewPi section keeps:
 *
 * - **No markup from data.** Every value from the host is written with
 *   `textContent`; the injected code never assigns `innerHTML`.
 * - **No name from the browser.** The page sends a command line and nothing
 *   else — not a directory, not a shell, not an environment.
 * - **No secret on screen.** The panel renders what a command printed, which is
 *   the user's own output and the one thing a console is for.
 * - **Nothing keeps running unseen.** The stop button aborts the request, and
 *   the host kills the whole process group when it does.
 * - **The engine's markup is never rewritten.** The panel is one row appended
 *   to the sidebar's footer seat and one overlay of our own.
 *
 * @module newpi-plugin-terminal-console/ui
 */

/** The marker attribute that makes the injected nodes recognisable. */
export const TERMINAL_ATTRIBUTE = 'data-newpi-terminal';

/** The sidebar seat the row is added to, the same one Memory, Storage and Projects use. */
export const NAV_SEAT = 'sidebar.footer.action';

/** Below this width the sidebar is a collapsed rail and the row shows its icon alone. */
const RAIL_WIDTH = 120;

/** Total output the panel keeps, in characters, before it drops the oldest. */
const PANEL_OUTPUT_LIMIT = 400 * 1024;

/** The panel's stylesheet. */
export function terminalStyle() {
  return (
    `.npt-row{cursor:pointer;width:100%;height:36px;color:var(--dsw-alias-label-primary,#e6e6e6);` +
    `background:0 0;border:none;border-radius:8px;display:flex;align-items:center;gap:10px;padding:0 8px;` +
    `font-size:13px;line-height:20px;text-align:left;}` +
    `.npt-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));}` +
    `.npt-row svg{flex:none;width:16px;height:16px;color:var(--dsw-alias-label-secondary,#b3b3b3);}` +
    `.npt-row-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}` +
    `@media (max-width:${RAIL_WIDTH}px){.npt-row-label{display:none;}.npt-row{justify-content:center;}}` +
    `.npt-panel{position:fixed;right:16px;bottom:16px;z-index:40;box-sizing:border-box;display:flex;` +
    `flex-direction:column;width:min(880px,62vw);height:min(58vh,520px);` +
    `background:var(--dsw-specific-sidebar-fill,#1b1b1f);color:var(--dsw-alias-label-primary,#e6e6e6);` +
    `border:1px solid var(--dsw-alias-border-l4,rgba(255,255,255,.12));border-radius:12px;` +
    `box-shadow:0 18px 48px rgba(0,0,0,.45);overflow:hidden;}` +
    `.npt-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--npt-line,rgba(255,255,255,.1));}` +
    `.npt-title{font-size:13px;font-weight:600;}` +
    `.npt-dim{color:var(--dsw-alias-label-tertiary,#8f8f8f);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46%;}` +
    `.npt-spacer{flex:1;}` +
    `.npt-icon{cursor:pointer;width:24px;height:24px;color:var(--dsw-alias-label-secondary,#b3b3b3);background:0 0;border:none;border-radius:6px;font-size:14px;line-height:1;}` +
    `.npt-icon:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));}` +
    `.npt-out{flex:1;margin:0;padding:10px 12px;overflow:auto;white-space:pre-wrap;word-break:break-word;` +
    `font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:17px;}` +
    `.npt-status{padding:4px 12px;color:var(--dsw-alias-label-tertiary,#8f8f8f);font-size:12px;border-top:1px solid var(--npt-line,rgba(255,255,255,.1));}` +
    `.npt-status[data-kind="error"]{color:var(--dsw-alias-state-error-primary,#ff6b6b);}` +
    `.npt-status[data-kind="ok"]{color:var(--dsw-alias-state-business-primary,#4ade80);}` +
    `.npt-form{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--npt-line,rgba(255,255,255,.1));}` +
    `.npt-prompt{color:var(--dsw-alias-label-tertiary,#8f8f8f);font-family:ui-monospace,Menlo,monospace;font-size:12px;}` +
    `.npt-input{flex:1;min-width:0;background:0 0;border:none;outline:none;color:inherit;` +
    `font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;}` +
    `.npt-run{cursor:pointer;height:26px;padding:0 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l4,rgba(255,255,255,.16));` +
    `background:var(--dsw-alias-button-elevated-fill,rgba(255,255,255,.08));color:inherit;font-size:12px;}` +
    `.npt-run:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.14));}`
  );
}

/**
 * The client the page runs.
 *
 * Kept as one self-contained function: it is serialised, so it may not close
 * over anything from this module.
 *
 * @param facts - the values the host inlined when the index was rendered.
 */
export function terminalClient(facts) {
  var doc = document;
  if (doc.querySelector('[' + 'data-newpi-terminal-mounted' + ']') !== null) return;

  var history = [];
  var cursor = 0;
  var running = null;
  var pending = null;
  var outputLength = 0;
  var limit = typeof facts.maxOutputBytes === 'number' ? Math.min(facts.maxOutputBytes, 400 * 1024) : 400 * 1024;

  function el(tag, className, text) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function icon() {
    var svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    var frame = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
    frame.setAttribute('x', '1.5');
    frame.setAttribute('y', '2.5');
    frame.setAttribute('width', '13');
    frame.setAttribute('height', '11');
    frame.setAttribute('rx', '2');
    frame.setAttribute('fill', 'none');
    frame.setAttribute('stroke', 'currentColor');
    frame.setAttribute('stroke-width', '1.3');
    svg.appendChild(frame);
    var chevron = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    chevron.setAttribute('d', 'M5 6.5 7.5 8.5 5 10.5M9 10.5h2.5');
    chevron.setAttribute('fill', 'none');
    chevron.setAttribute('stroke', 'currentColor');
    chevron.setAttribute('stroke-width', '1.3');
    chevron.setAttribute('stroke-linecap', 'round');
    svg.appendChild(chevron);
    return svg;
  }

  var panel = el('section', 'npt-panel');
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Console');

  var head = el('div', 'npt-head');
  head.appendChild(el('span', 'npt-title', 'Console'));
  head.appendChild(el('span', 'npt-dim', facts.workspace || 'dossier inconnu'));
  head.appendChild(el('span', 'npt-spacer'));
  var clearButton = el('button', 'npt-icon', '⌫');
  clearButton.type = 'button';
  clearButton.title = 'Effacer la sortie';
  clearButton.setAttribute('aria-label', 'Effacer la sortie');
  var closeButton = el('button', 'npt-icon', '✕');
  closeButton.type = 'button';
  closeButton.title = 'Fermer';
  closeButton.setAttribute('aria-label', 'Fermer');
  head.appendChild(clearButton);
  head.appendChild(closeButton);
  panel.appendChild(head);

  var out = el('pre', 'npt-out');
  out.setAttribute('tabindex', '0');
  panel.appendChild(out);

  var status = el('div', 'npt-status', 'Prêt — Entrée exécute, ↑/↓ rappellent, Ctrl+C arrête.');
  panel.appendChild(status);

  var form = el('form', 'npt-form');
  form.appendChild(el('span', 'npt-prompt', '›'));
  var input = el('input', 'npt-input');
  input.type = 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.placeholder = 'git status';
  input.setAttribute('aria-label', 'Commande');
  form.appendChild(input);
  var runButton = el('button', 'npt-run', 'Exécuter');
  runButton.type = 'submit';
  form.appendChild(runButton);
  var stopButton = el('button', 'npt-run', 'Arrêter');
  stopButton.type = 'button';
  stopButton.hidden = true;
  form.appendChild(stopButton);
  panel.appendChild(form);
  doc.body.appendChild(panel);

  function append(text) {
    if (!text) return;
    var next = out.textContent + text;
    if (next.length > limit) next = next.slice(next.length - limit);
    outputLength = next.length;
    var pinned = out.scrollTop + out.clientHeight >= out.scrollHeight - 24;
    out.textContent = next;
    if (pinned) out.scrollTop = out.scrollHeight;
  }

  function setStatus(text, kind) {
    status.textContent = text;
    if (kind) status.setAttribute('data-kind', kind);
    else status.removeAttribute('data-kind');
  }

  function open() {
    panel.hidden = false;
    input.focus();
  }

  function close() {
    panel.hidden = true;
  }

  function finish() {
    running = null;
    runButton.hidden = false;
    stopButton.hidden = true;
    input.focus();
  }

  function handleFrame(line) {
    if (line === '') return;
    var frame;
    try {
      frame = JSON.parse(line);
    } catch (error) {
      append(line + '\n');
      return;
    }
    if (frame.type === 'out') {
      append(frame.text);
      return;
    }
    if (frame.type === 'error') {
      append('\n' + frame.message + '\n');
      setStatus(frame.message, 'error');
      return;
    }
    if (frame.type === 'exit') {
      var seconds = (frame.ms / 1000).toFixed(1);
      if (frame.code === 0) setStatus('Terminé en ' + seconds + ' s.' + (frame.truncated ? ' Sortie tronquée.' : ''), 'ok');
      else if (frame.code === null) setStatus('Arrêté en ' + seconds + ' s.' + (frame.signal ? ' (' + frame.signal + ')' : ''), 'error');
      else setStatus('Code ' + frame.code + ' en ' + seconds + ' s.' + (frame.truncated ? ' Sortie tronquée.' : ''), 'error');
    }
  }

  function run(command) {
    if (running !== null) return;
    if (command === '') return;
    open();
    append('\n› ' + command + '\n');
    setStatus('En cours…');
    runButton.hidden = true;
    stopButton.hidden = false;
    var controller = new AbortController();
    running = controller;
    fetch(facts.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: command }),
      signal: controller.signal,
    })
      .then(function (response) {
        if (!response.ok) {
          return response
            .json()
            .then(function (body) {
              throw new Error((body && body.error && body.error.message) || 'HTTP ' + response.status);
            })
            .catch(function () {
              throw new Error('HTTP ' + response.status);
            });
        }
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';
        function pump() {
          return reader.read().then(function (result) {
            if (result.done) {
              if (buffer !== '') handleFrame(buffer);
              return undefined;
            }
            buffer += decoder.decode(result.value, { stream: true });
            var index = buffer.indexOf('\n');
            while (index !== -1) {
              handleFrame(buffer.slice(0, index));
              buffer = buffer.slice(index + 1);
              index = buffer.indexOf('\n');
            }
            return pump();
          });
        }
        return pump();
      })
      .catch(function (error) {
        if (error && error.name === 'AbortError') setStatus('Arrêtée.', 'error');
        else {
          append('\n' + String((error && error.message) || error) + '\n');
          setStatus('Échec de la requête.', 'error');
        }
      })
      .then(finish);
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var command = input.value.trim();
    if (command === '') return;
    history.push(command);
    cursor = history.length;
    input.value = '';
    run(command);
  });

  stopButton.addEventListener('click', function () {
    if (running !== null) running.abort();
  });

  clearButton.addEventListener('click', function () {
    out.textContent = '';
    outputLength = 0;
    setStatus('Sortie effacée.');
  });

  closeButton.addEventListener('click', close);

  input.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (cursor > 0) {
        cursor -= 1;
        input.value = history[cursor] || '';
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (cursor < history.length - 1) {
        cursor += 1;
        input.value = history[cursor] || '';
      } else {
        cursor = history.length;
        input.value = '';
      }
      return;
    }
    if (event.key === 'c' && (event.ctrlKey || event.metaKey) && running !== null) {
      event.preventDefault();
      running.abort();
    }
  });

  doc.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && panel.hidden === false) close();
  });

  function mountRow() {
    var seat = doc.querySelector('[data-slot="' + 'sidebar.footer.action' + '"]');
    if (seat === null) return false;
    var row = el('button', 'npt-row');
    row.type = 'button';
    row.title = 'Console';
    row.setAttribute('aria-label', 'Console');
    row.setAttribute('data-newpi-terminal-mounted', '');
    row.appendChild(icon());
    row.appendChild(el('span', 'npt-row-label', 'Console'));
    row.addEventListener('click', open);
    seat.appendChild(row);
    return true;
  }

  if (!mountRow()) {
    var attempts = 0;
    var timer = setInterval(function () {
      attempts += 1;
      if (mountRow() || attempts > 120) clearInterval(timer);
    }, 500);
  }
}

/**
 * The script the page receives: the client above, called with its facts.
 *
 * @param facts - the values to inline.
 * @returns the executable script source.
 */
export function terminalScript(facts = {}) {
  return `(${terminalClient.toString()})(${safeJson(facts)});`;
}

/**
 * Serialise the inlined facts without a way out of the `<script>` element.
 *
 * @param value - the value to inline.
 * @returns JSON with the markup-significant characters escaped.
 */
export function safeJson(value) {
  return JSON.stringify(value === undefined ? null : value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Splice the console into a rendered index document.
 *
 * @param html - the document the webserver rendered.
 * @param facts - the values the panel starts from.
 * @returns the document with one style and one script added.
 */
export function installTerminal(html, facts = {}) {
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  const markup =
    `<style ${TERMINAL_ATTRIBUTE}>${terminalStyle()}</style>` +
    `<script ${TERMINAL_ATTRIBUTE}>${terminalScript(facts)}</script>`;
  if (head === null) return `${markup}${html}`;
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}${markup}${html.slice(at)}`;
}
