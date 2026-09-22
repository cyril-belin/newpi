/**
 * The Storage section, as the interface renders it.
 *
 * A third injected section, built the same way as Memory and Backup: one
 * `<style>` and one `<script>` spliced into the document head by `tapIndex`,
 * one row added to the sidebar's footer actions, one overlay panel. No engine
 * file is written and no engine markup is rewritten.
 *
 * The client below is a real function, not a string. It is syntax-checked with
 * the rest of the plugin, run for real against a fake DOM in the test suite,
 * and serialised into the page with `Function.prototype.toString`.
 *
 * Four rules it keeps, the first three inherited from the memory console:
 *
 * - **No markup from data.** Every value from the host is written with
 *   `textContent`. The injected code never touches `innerHTML`.
 * - **No path from the browser.** It sends catalog ids. The target path comes
 *   back from the host for display only, and is never sent anywhere.
 * - **Never throw into the page.** Every entry point is wrapped.
 * - **Deletion is typed, not clicked.** A cleanup runs only after the user
 *   types the target's identifier into a field, which is the same requirement
 *   the endpoint enforces independently. A dialog with a "yes" button is a
 *   dialog people learn to dismiss.
 *
 * @module newpi-plugin-storage-console/ui
 */

/**
 * The sidebar seat the row is added to. The same correction the memory console
 * documents at length: the footer is for injected buttons, the panel list is
 * for components the shell knows about.
 */
export const NAV_SEATS = ['sidebar.footer.action'];

/** The marker attribute that makes the injected nodes recognisable. */
export const STORAGE_ATTRIBUTE = 'data-newpi-storage';

/** Below this width the sidebar is a collapsed rail and the row shows its icon
 * alone. Matches the width the engine's own rail collapses to (56px). */
const RAIL_WIDTH = 120;

/** The role labels the section renders. Kept here rather than sent by the host:
 * a label is presentation, and the policy travels on its own. */
const ROLE_LABELS = {
  build: 'build jetable',
  cache: 'cache reconstructible',
  logs: 'journaux',
  sessions: 'sessions',
  memory: 'mémoire',
  backups: 'sauvegardes',
  runtime: 'état applicatif',
  data: 'données',
};

/**
 * The styling of the section.
 *
 * Colours come from the interface's own theme variables with literal fallbacks,
 * so the panel follows the light and dark themes without knowing them. The
 * prefix is `nps-`, not `npc-`: the memory console owns that one, and two
 * plugins sharing class names is a stylesheet that changes when the other
 * plugin is disabled.
 *
 * @returns the CSS text.
 */
export function storageStyle() {
  return [
    `[${STORAGE_ATTRIBUTE}]{--nps-bg:var(--dsw-alias-bg-layer-1,#fff);--nps-bg2:var(--dsw-alias-bg-layer-2,#f6f6f7);`,
    `--nps-fg:var(--dsw-alias-label-primary,#111);--nps-dim:var(--dsw-alias-label-tertiary,#6b6b70);`,
    `--nps-line:var(--dsw-alias-border-l2,rgba(0,0,0,.12));--nps-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));`,
    `--nps-accent:var(--dsw-alias-brand-primary,#2f6feb);--nps-danger:var(--dsw-alias-state-error-primary,#c0392b);`,
    `--nps-warn:var(--dsw-alias-state-warn-primary,#b8860b);--nps-ok:var(--dsw-alias-state-success-primary,#2e7d32);`,
    `font:400 13px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;color:var(--nps-fg);}`,

    `.nps-navrow{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;`,
    `margin:1px 0;padding:6px 8px;border:0;border-radius:8px;background:transparent;`,
    `font:inherit;color:inherit;text-align:left;cursor:pointer;}`,
    `.nps-navrow:hover{background:var(--nps-hover);}`,
    `.nps-navrow svg{flex:0 0 auto;width:16px;height:16px;opacity:.75;}`,
    `.nps-navrow span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}`,
    `.nps-navrow.nps-rail{justify-content:center;gap:0;padding:6px 0;}`,
    `.nps-navrow.nps-rail span{display:none;}`,

    `.nps-chip{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;gap:8px;}`,
    `.nps-chip button{border:1px solid var(--nps-line);background:var(--nps-bg);color:inherit;`,
    `border-radius:999px;padding:6px 12px;font:inherit;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.12);}`,

    `.nps-root{position:fixed;inset:0;z-index:2147483200;display:flex;align-items:center;`,
    `justify-content:center;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.35));}`,
    `.nps-root[hidden]{display:none;}`,
    `.nps-panel{display:flex;flex-direction:column;width:min(960px,94vw);height:min(800px,90vh);`,
    `background:var(--nps-bg);border:1px solid var(--nps-line);border-radius:14px;overflow:hidden;`,
    `box-shadow:0 24px 70px rgba(0,0,0,.35);}`,
    `.nps-head{display:flex;align-items:baseline;gap:12px;padding:16px 18px;border-bottom:1px solid var(--nps-line);}`,
    `.nps-head h2{margin:0;font-size:15px;font-weight:600;}`,
    `.nps-head .nps-dim{color:var(--nps-dim);font-size:12px;}`,
    `.nps-head .nps-spacer{flex:1;}`,
    `.nps-body{flex:1;overflow:auto;padding:16px 18px;}`,
    `.nps-foot{padding:10px 18px;border-top:1px solid var(--nps-line);color:var(--nps-dim);font-size:12px;}`,
    `.nps-foot:empty{display:none;}`,

    `.nps-btn{border:1px solid var(--nps-line);background:var(--nps-bg2);color:inherit;border-radius:8px;`,
    `padding:6px 12px;font:inherit;cursor:pointer;}`,
    `.nps-btn:hover{background:var(--nps-hover);}`,
    `.nps-btn[disabled]{opacity:.45;cursor:default;}`,
    `.nps-btn.nps-primary{background:var(--dsw-alias-button-primary-fill,#2f6feb);`,
    `border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff);}`,
    `.nps-btn.nps-danger{color:#fff;background:var(--nps-danger);border-color:transparent;}`,
    `.nps-btn.nps-small{padding:4px 9px;font-size:12px;}`,

    `.nps-stats{display:flex;gap:16px;flex-wrap:wrap;margin:4px 0 14px;color:var(--nps-dim);font-size:12px;}`,
    `.nps-stats b{color:var(--nps-fg);font-weight:600;font-variant-numeric:tabular-nums;}`,
    `.nps-h3{margin:20px 0 8px;font-size:13px;font-weight:600;}`,
    `.nps-h3:first-child{margin-top:0;}`,
    `.nps-h3 .nps-dim{font-weight:400;color:var(--nps-dim);}`,

    `.nps-table{width:100%;border-collapse:collapse;font-size:12.5px;}`,
    `.nps-table th{text-align:left;font-weight:500;color:var(--nps-dim);padding:4px 8px;`,
    `border-bottom:1px solid var(--nps-line);font-size:11px;text-transform:uppercase;letter-spacing:.04em;}`,
    `.nps-table td{padding:7px 8px;border-bottom:1px solid var(--nps-line);vertical-align:top;}`,
    `.nps-table td.nps-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}`,
    `.nps-table tr.nps-over td{color:var(--nps-dim);}`,
    `.nps-name{display:block;font-weight:500;}`,
    `.nps-what{display:block;color:var(--nps-dim);font-size:11.5px;margin-top:2px;}`,
    `.nps-path{display:block;color:var(--nps-dim);font-size:11px;word-break:break-all;`,
    `font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);margin-top:3px;}`,

    `.nps-tag{display:inline-block;padding:1px 7px;border-radius:999px;border:1px solid var(--nps-line);`,
    `font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--nps-dim);white-space:nowrap;}`,
    `.nps-tag.nps-safe{color:var(--nps-ok);border-color:var(--nps-ok);}`,
    `.nps-tag.nps-guarded{color:var(--nps-warn);border-color:var(--nps-warn);}`,
    `.nps-tag.nps-over{color:var(--nps-danger);border-color:var(--nps-danger);}`,

    `.nps-note{margin:10px 0;padding:10px 12px;border-radius:10px;border:1px solid var(--nps-line);`,
    `background:var(--nps-bg2);white-space:pre-wrap;}`,
    `.nps-note.nps-error{border-color:var(--nps-danger);color:var(--nps-danger);}`,
    `.nps-note.nps-warn{border-color:var(--nps-warn);color:var(--nps-warn);}`,
    `.nps-note.nps-ok{border-color:var(--nps-ok);color:var(--nps-ok);}`,

    `.nps-kv{display:grid;grid-template-columns:max-content 1fr;gap:5px 14px;margin:10px 0;}`,
    `.nps-kv dt{color:var(--nps-dim);}`,
    `.nps-kv dd{margin:0;word-break:break-word;}`,
    `.nps-kv dd.nps-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;}`,
    `.nps-confirm{margin:14px 0;padding:12px;border:1px solid var(--nps-danger);border-radius:10px;}`,
    `.nps-confirm h4{margin:0 0 6px;font-size:13px;}`,
    `.nps-confirm label{display:block;margin:8px 0 4px;color:var(--nps-dim);font-size:12px;}`,
    `.nps-confirm input{width:100%;box-sizing:border-box;font:inherit;color:inherit;background:var(--nps-bg2);`,
    `border:1px solid var(--nps-line);border-radius:8px;padding:6px 10px;}`,
    `.nps-confirm .nps-row{display:flex;gap:8px;align-items:center;margin-top:10px;}`,
    `.nps-policy{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:6px;}`,
    `.nps-policy li{padding:8px 10px;border:1px solid var(--nps-line);border-radius:10px;background:var(--nps-bg2);font-size:12px;}`,
    `.nps-policy b{display:block;font-size:12px;}`,
    `.nps-policy span{color:var(--nps-dim);}`,
    `.nps-empty{margin:24px auto;max-width:56ch;text-align:center;color:var(--nps-dim);}`,
  ].join('');
}

/**
 * The whole client side of the section.
 *
 * Self-contained on purpose: it closes over nothing, so it can be serialised
 * with `toString()` and shipped to the page. The test suite runs this very
 * function against a fake DOM.
 */
export function clientStorage() {
  var ENDPOINT = '/api/newpi.storage';
  var SEATS = SEAT_NAMES;
  var RAIL_WIDTH = RAIL_PIXELS;
  var ROLE_LABELS = ROLE_LABELS_JSON;
  var SCOPES = SCOPE_NAMES;

  var SCOPE_LABELS = {
    newpi: 'NewPi',
    dsh: 'DeepSeek Harness',
    toolchain: 'Outillage (Node, Rust, Xcode…)',
    other: 'Hors périmètre NewPi',
  };

  var state = null;

  /** Call one action of the storage endpoint. */
  function call(action, params) {
    return fetch(ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: action, params: params || {} }),
    })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return { ok: false, error: { code: 'STORAGE_BAD_JSON', message: 'Réponse illisible.' } };
          })
          .then(function (payload) {
            if (!payload || payload.ok !== true) {
              var error = (payload && payload.error) || {};
              throw new Error(error.message || 'Échec de la requête.');
            }
            return payload.value;
          });
      })
      .catch(function (error) {
        throw error instanceof Error ? error : new Error(String(error));
      });
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function button(className, text, onClick) {
    var node = el('button', className || 'nps-btn', text);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  /** A byte count, in the units a person reads. */
  function bytes(value) {
    if (value === null || value === undefined) return '—';
    var n = Number(value);
    if (!isFinite(n) || n < 0) return '—';
    var units = ['o', 'Kio', 'Mio', 'Gio', 'Tio'];
    var at = 0;
    while (n >= 1024 && at < units.length - 1) {
      n = n / 1024;
      at += 1;
    }
    var text = at === 0 ? String(Math.round(n)) : n.toFixed(n < 10 ? 1 : 0).replace('.', ',');
    return text + ' ' + units[at];
  }

  function tag(className, text) {
    return el('span', 'nps-tag ' + className, text);
  }

  /** The icon the sidebar row shows, drawn as markup so it needs no request. */
  function icon() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.3');
    var top = document.createElementNS(ns, 'ellipse');
    top.setAttribute('cx', '8');
    top.setAttribute('cy', '3.8');
    top.setAttribute('rx', '5.4');
    top.setAttribute('ry', '2.2');
    var body = document.createElementNS(ns, 'path');
    body.setAttribute('d', 'M2.6 3.8v8.4c0 1.2 2.4 2.2 5.4 2.2s5.4-1 5.4-2.2V3.8');
    var mid = document.createElementNS(ns, 'path');
    mid.setAttribute('d', 'M2.6 8c0 1.2 2.4 2.2 5.4 2.2s5.4-1 5.4-2.2');
    svg.appendChild(top);
    svg.appendChild(body);
    svg.appendChild(mid);
    return svg;
  }

  /** Replace the panel body with one message, without losing the panel. */
  function notice(state, message, kind) {
    var note = el('div', 'nps-note' + (kind ? ' nps-' + kind : ''), message);
    state.body.appendChild(note);
    return note;
  }

  /** Build the overlay once, on first open. */
  function ensurePanel() {
    if (state) return state;
    var root = el('div', 'nps-root');
    root.setAttribute('data-newpi-storage', '');
    root.hidden = true;

    var panel = el('div', 'nps-panel');
    var head = el('div', 'nps-head');
    head.appendChild(el('h2', null, 'Stockage'));
    var summary = el('span', 'nps-dim', '');
    head.appendChild(summary);
    head.appendChild(el('span', 'nps-spacer'));
    head.appendChild(
      button('nps-btn', 'Fermer', function () {
        root.hidden = true;
      }),
    );

    var body = el('div', 'nps-body');
    var foot = el('div', 'nps-foot', 'Aucune suppression de session, de mémoire PocketBase ou de sauvegarde n\'est possible ici.');
    panel.appendChild(head);
    panel.appendChild(body);
    panel.appendChild(foot);
    root.appendChild(panel);
    document.body.appendChild(root);

    root.addEventListener('click', function (event) {
      if (event.target === root) root.hidden = true;
    });

    state = { root: root, body: body, foot: foot, summary: summary, data: null, busy: false };
    return state;
  }

  // ------------------------------------------------------------- rendering

  /** One table row per catalog entry. */
  function renderEntry(state, entry, rows) {
    var tr = el('tr', entry.overlaps ? 'nps-over' : null);

    var nameCell = el('td');
    nameCell.appendChild(el('span', 'nps-name', entry.label));
    nameCell.appendChild(el('span', 'nps-what', entry.what));
    if (entry.path) nameCell.appendChild(el('span', 'nps-path', entry.path));
    tr.appendChild(nameCell);

    var roleCell = el('td');
    roleCell.appendChild(tag(null, ROLE_LABELS[entry.role] || entry.role));
    tr.appendChild(roleCell);

    var safetyCell = el('td');
    safetyCell.appendChild(
      tag(entry.safety === 'safe' ? 'nps-safe' : 'nps-guarded',
        entry.safety === 'safe' ? 'reconstructible' : 'protégé'),
    );
    tr.appendChild(safetyCell);

    var sizeCell = el('td', 'nps-num');
    var measured = entry.measurement;
    sizeCell.textContent = measured ? bytes(measured.allocated) : '—';
    if (measured && measured.truncated) {
      sizeCell.appendChild(el('span', 'nps-what', 'mesure partielle'));
    }
    tr.appendChild(sizeCell);

    var logicalCell = el('td', 'nps-num');
    logicalCell.textContent =
      measured && measured.bytes !== measured.allocated ? bytes(measured.bytes) : '—';
    tr.appendChild(logicalCell);

    var actionCell = el('td');
    if (entry.safety === 'safe') {
      var over = entry.budgetBytes !== null && measured && measured.allocated > entry.budgetBytes;
      if (over) actionCell.appendChild(tag('nps-over', 'hors budget'));
      // The button is offered whatever the size: a cache the user wants gone is
      // a cache the user wants gone, and the preview states the cost first.
      actionCell.appendChild(
        button('nps-btn nps-small', 'Nettoyer…', function () {
          openConfirm(state, entry);
        }),
      );
    } else {
      actionCell.appendChild(tag('nps-guarded', 'non supprimable ici'));
    }
    tr.appendChild(actionCell);

    rows.appendChild(tr);
  }

  /** The whole picture: totals, then one table per scope, then the policy. */
  function renderStatus(state, data) {
    state.data = data;
    state.body.textContent = '';

    var stats = el('div', 'nps-stats');
    function stat(label, value) {
      var box = el('span');
      box.appendChild(el('b', null, value));
      box.appendChild(document.createTextNode(' ' + label));
      stats.appendChild(box);
    }
    stat('mesurés (alloué)', bytes(data.totals.allocated));
    stat('cibles', String(data.entries.length));
    stat('restantes à mesurer', String(data.totals.unmeasured.length));
    if (data.totals.unmeasured.length > 0) {
      stats.appendChild(
        button('nps-btn nps-small', 'Tout mesurer', function () {
          runScan(state, {});
        }),
      );
    }
    state.body.appendChild(stats);

    SCOPES.forEach(function (scope) {
      var entries = data.entries.filter(function (entry) {
        return entry.scope === scope;
      });
      if (entries.length === 0) return;
      var head = el('h3', 'nps-h3');
      head.appendChild(document.createTextNode(SCOPE_LABELS[scope] || scope));
      head.appendChild(document.createTextNode(' '));
      head.appendChild(el('span', 'nps-dim', bytes(data.totals.byScope[scope] || 0)));
      head.appendChild(document.createTextNode(' '));
      head.appendChild(
        button('nps-btn nps-small', 'Mesurer', function () {
          runScan(state, { scopes: [scope] });
        }),
      );
      state.body.appendChild(head);

      var table = el('table', 'nps-table');
      var thead = el('thead');
      var hrow = el('tr');
      ['Cible', 'Rôle', 'Classe', 'Alloué', 'Logique', ''].forEach(function (label) {
        hrow.appendChild(el('th', null, label));
      });
      thead.appendChild(hrow);
      table.appendChild(thead);
      var tbody = el('tbody');
      entries.forEach(function (entry) {
        renderEntry(state, entry, tbody);
      });
      table.appendChild(tbody);
      state.body.appendChild(table);
    });

    var policyHead = el('h3', 'nps-h3', 'Politique de rétention');
    state.body.appendChild(policyHead);
    var list = el('ul', 'nps-policy');
    Object.keys(data.policy).forEach(function (role) {
      var rule = data.policy[role];
      var item = el('li');
      item.appendChild(el('b', null, (ROLE_LABELS[role] || role) + ' — ' + rule.automatic));
      item.appendChild(el('span', null, rule.note));
      list.appendChild(item);
    });
    state.body.appendChild(list);

    var project = data.project || {};
    state.summary.textContent =
      project.name && project.root
        ? 'projet ' + project.name + ' · ' + project.root
        : 'Aucun projet ouvert';
  }

  // --------------------------------------------------------------- actions

  function runScan(state, params) {
    if (state.busy) return;
    state.busy = true;
    notice(state, 'Mesure en cours…');
    call('storage.scan', params)
      .then(function (data) {
        state.busy = false;
        renderStatus(state, data);
      })
      .catch(function (error) {
        state.busy = false;
        state.body.textContent = '';
        notice(state, 'La mesure a échoué : ' + error.message, 'error');
      });
  }

  /** The confirmation screen: target, sizes, cost, and a field to type the id. */
  function openConfirm(state, entry) {
    state.body.textContent = '';
    notice(state, 'Mesure de la cible…');
    call('storage.preview', { id: entry.id })
      .then(function (preview) {
        state.body.textContent = '';
        var heading = el('h3', 'nps-h3', 'Nettoyer : ' + preview.label);
        state.body.appendChild(heading);

        var kv = el('dl', 'nps-kv');
        function pair(term, value, mono) {
          kv.appendChild(el('dt', null, term));
          kv.appendChild(el('dd', mono ? 'nps-mono' : null, value));
        }
        pair('Cible', preview.target, true);
        pair('Classe', preview.safety === 'safe' ? 'reconstructible' : 'protégée');
        pair('Mode', preview.cleanup === 'clear-contents' ? 'vider le dossier, garder sa place' : 'supprimer le dossier');
        pair(
          'Taille allouée',
          preview.measurement ? bytes(preview.measurement.allocated) : '—',
        );
        pair(
          'Taille logique',
          preview.measurement ? bytes(preview.measurement.bytes) : '—',
        );
        pair(
          'Contenu',
          preview.measurement
            ? preview.measurement.files + ' fichier(s), ' + preview.measurement.directories + ' dossier(s)'
            : '—',
        );
        pair('Ce que c\'est', preview.what);
        pair('Ce que cela coûte', preview.cost);
        state.body.appendChild(kv);

        if (!preview.removable) {
          notice(state, preview.refusal || 'Cible protégée.', 'warn');
          state.body.appendChild(
            button('nps-btn', '← Retour', function () {
              renderStatus(state, state.data);
            }),
          );
          return;
        }

        var zone = el('div', 'nps-confirm');
        zone.appendChild(el('h4', null, 'Confirmation explicite'));
        zone.appendChild(
          el(
            'div',
            'nps-what',
            'Rien n\'est récupérable après cette action, même si le contenu est reconstructible. ' +
              'Recopiez l\'identifiant de la cible pour l\'autoriser.',
          ),
        );
        zone.appendChild(el('label', null, 'Identifiant à recopier : ' + entry.id));
        var field = document.createElement('input');
        field.type = 'text';
        field.placeholder = entry.id;
        field.setAttribute('autocomplete', 'off');
        field.setAttribute('spellcheck', 'false');
        zone.appendChild(field);

        var row = el('div', 'nps-row');
        var go = button('nps-btn nps-danger', 'Supprimer', function () {
          runClean(state, entry, preview, field.value);
        });
        go.disabled = true;
        field.addEventListener('input', function () {
          go.disabled = field.value.trim() !== entry.id;
        });
        row.appendChild(go);
        row.appendChild(
          button('nps-btn', 'Annuler', function () {
            renderStatus(state, state.data);
          }),
        );
        zone.appendChild(row);
        state.body.appendChild(zone);
        field.focus();
      })
      .catch(function (error) {
        state.body.textContent = '';
        notice(state, 'Aperçu impossible : ' + error.message, 'error');
        state.body.appendChild(
          button('nps-btn', '← Retour', function () {
            renderStatus(state, state.data);
          }),
        );
      });
  }

  function runClean(state, entry, preview, typed) {
    var expect = preview.measurement ? preview.measurement.allocated : 0;
    state.busy = true;
    notice(state, 'Suppression en cours…');
    call('storage.clean', { id: entry.id, confirm: typed, expectBytes: expect })
      .then(function (report) {
        state.busy = false;
        return call('storage.status').then(function (data) {
          renderStatus(state, data);
          notice(
            state,
            report.removed
              ? 'Nettoyé : ' + bytes(report.freed) + ' récupérés dans ' + report.target
              : 'Rien à nettoyer : ' + report.target + ' était déjà absent.',
            'ok',
          );
        });
      })
      .catch(function (error) {
        state.busy = false;
        state.body.textContent = '';
        notice(state, 'Suppression refusée ou échouée : ' + error.message, 'error');
        state.body.appendChild(
          button('nps-btn', '← Retour', function () {
            renderStatus(state, state.data);
          }),
        );
      });
  }

  // ----------------------------------------------------------------- shell

  function openPanel() {
    var current = ensurePanel();
    current.root.hidden = false;
    if (current.data) {
      renderStatus(current, current.data);
      return;
    }
    current.body.textContent = '';
    notice(current, 'Lecture de l\'état du disque…');
    call('storage.status')
      .then(function (data) {
        renderStatus(current, data);
        // The two scopes that belong to NewPi and its engine are small and are
        // measured straight away. The toolchain and the rest are a button, not
        // a surprise: walking an Xcode build directory takes seconds.
        return call('storage.scan', { scopes: ['newpi', 'dsh'] }).then(function (fresh) {
          renderStatus(current, fresh);
        });
      })
      .catch(function (error) {
        current.body.textContent = '';
        notice(current, 'État illisible : ' + error.message, 'error');
      });
  }

  /** The width of the box a seat sits in, or 0 when nothing is laid out yet. */
  function seatWidth(seat) {
    var node = seat;
    while (node && node.clientWidth === 0 && node.parentElement) node = node.parentElement;
    return node ? node.clientWidth : 0;
  }

  function adaptToRail(seat, node) {
    var width = seatWidth(seat);
    if (width > 0 && width < RAIL_WIDTH) node.classList.add('nps-rail');
    else node.classList.remove('nps-rail');
  }

  /** The sidebar row, added to the first seat this build renders. */
  function installNav() {
    var seat = null;
    for (var index = 0; index < SEATS.length; index += 1) {
      seat = document.querySelector('[data-slot="' + SEATS[index] + '"]');
      if (seat) break;
    }
    if (!seat) return false;
    if (seat.querySelector('[data-newpi-storage-nav]')) return true;

    var node = button('nps-navrow', null, function () {
      openPanel();
    });
    node.setAttribute('data-newpi-storage-nav', '');
    node.setAttribute('title', 'Storage');
    node.appendChild(icon());
    node.appendChild(el('span', null, 'Storage'));
    seat.appendChild(node);

    adaptToRail(seat, node);
    var box = seatWidth(seat) > 0 ? seat : seat.parentElement;
    if (box && typeof ResizeObserver === 'function') {
      try {
        new ResizeObserver(function () {
          adaptToRail(seat, node);
        }).observe(box);
      } catch (error) {
        // A browser without a usable ResizeObserver keeps the expanded row.
      }
    }
    return true;
  }

  /** A floating button, when the sidebar offers no seat at all. */
  function installFallback() {
    if (document.querySelector('[data-newpi-storage-chip]')) return;
    if (!document.body) return;
    var chip = el('div', 'nps-chip');
    chip.setAttribute('data-newpi-storage-chip', '');
    chip.appendChild(
      button(null, 'Storage', function () {
        openPanel();
      }),
    );
    document.body.appendChild(chip);
  }

  /** Wire everything up, and never let a failure escape into the page. */
  function start() {
    try {
      window.addEventListener('keydown', function (event) {
        if (state && event.key === 'Escape' && !state.root.hidden) state.root.hidden = true;
      });
      if (installNav()) return;
      var observer = new MutationObserver(function () {
        if (installNav()) observer.disconnect();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      window.addEventListener('load', function () {
        installNav();
      });
      setTimeout(function () {
        observer.disconnect();
        if (!installNav()) installFallback();
      }, 4000);
    } catch (error) {
      if (window.console && window.console.error) {
        window.console.error('newpi storage console: ' + error);
      }
    }
  }

  start();
}

/**
 * The script the page runs, as text.
 *
 * @returns the script body, without its `<script>` wrapper.
 */
export function storageScript() {
  // A function serialised with `toString` cannot close over a module constant,
  // so the three tables are substituted into its source before it is shipped.
  const source = clientStorage
    .toString()
    .replace('var SEATS = SEAT_NAMES;', `var SEATS = ${JSON.stringify(NAV_SEATS)};`)
    .replace('var RAIL_WIDTH = RAIL_PIXELS;', `var RAIL_WIDTH = ${Number(RAIL_WIDTH)};`)
    .replace('var ROLE_LABELS = ROLE_LABELS_JSON;', `var ROLE_LABELS = ${JSON.stringify(ROLE_LABELS)};`)
    .replace('var SCOPES = SCOPE_NAMES;', `var SCOPES = ${JSON.stringify(['newpi', 'dsh', 'toolchain', 'other'])};`);
  return `(${source})();`;
}

/**
 * Inject the section into the rendered interface.
 *
 * A pure function of its input, as `tapIndex` requires: no state, no clock, no
 * I/O.
 *
 * @param html - the rendered `index.html` body.
 * @returns the body with the section's style and script added.
 */
export function installStorage(html) {
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  const markup =
    `<style ${STORAGE_ATTRIBUTE}>${storageStyle()}</style>` +
    `<script ${STORAGE_ATTRIBUTE}>${storageScript()}</script>`;
  if (head === null) return `${markup}${html}`;
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}${markup}${html.slice(at)}`;
}
