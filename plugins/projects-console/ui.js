/**
 * The Projects section, as the interface renders it.
 *
 * Built exactly like Memory, Backup and Storage: one `<style>` and one
 * `<script>` spliced into the document head by `tapIndex`, one row added to the
 * sidebar's footer actions, one overlay panel. No engine file is written and no
 * engine markup is rewritten.
 *
 * The client below is a real function, not a string. It is syntax-checked with
 * the rest of the plugin, run for real against a fake DOM in the test suite,
 * and serialised into the page with `Function.prototype.toString`.
 *
 * Five rules it keeps:
 *
 * - **No markup from data.** Every value from the host is written with
 *   `textContent`. The injected code never touches `innerHTML`.
 * - **No name from the browser.** It sends an action name and, at most, a
 *   project id or the path the *native panel* just returned. It never invents a
 *   capability, a namespace or a project fact.
 * - **No internal identifier on screen.** The panel never prints a project id,
 *   a workspace id, a memory namespace, a session id or a handoff digest: only
 *   a readable name, a folder, dates and capability words.
 * - **Never throw into the page.** Every entry point is wrapped.
 * - **A change is read before it is made.** The panel asks the Project Model
 *   for the in-flight operations before it offers a switch, and it says why
 *   when the model refuses one.
 *
 * @module newpi-plugin-projects-console/ui
 */

/** The sidebar seat the row is added to, the same one Memory and Storage use. */
export const NAV_SEATS = ['sidebar.footer.action'];

/** The marker attribute that makes the injected nodes recognisable. */
export const PROJECTS_ATTRIBUTE = 'data-newpi-projects';

/** Below this width the sidebar is a collapsed rail and the row shows its icon
 * alone. Matches the width the engine's own rail collapses to. */
const RAIL_WIDTH = 120;

/** The five capabilities, in the order the panel reads them. */
export const CAPABILITY_ORDER = [
  'readWorkspace',
  'writeWorkspace',
  'terminal',
  'git',
  'network',
];

/**
 * What each capability is called on screen. The names are the model's own, in
 * words a person reads; the panel never changes what a capability means.
 */
export const CAPABILITY_LABELS = {
  readWorkspace: 'Lire le projet',
  writeWorkspace: 'Écrire dans le projet',
  terminal: 'Terminal',
  git: 'Git',
  network: 'Réseau',
};

/**
 * The styling of the section.
 *
 * Colours come from the interface's own theme variables with literal fallbacks,
 * so the panel follows the light and dark themes without knowing them. The
 * prefix is `npr-`: the memory console owns `npc-` and the storage console
 * `nps-`, and two plugins sharing class names is a stylesheet that changes when
 * the other plugin is disabled.
 *
 * @returns the CSS text.
 */
export function projectsStyle() {
  return [
    `[${PROJECTS_ATTRIBUTE}]{--npr-bg:var(--dsw-alias-bg-layer-1,#fff);--npr-bg2:var(--dsw-alias-bg-layer-2,#f6f6f7);`,
    `--npr-fg:var(--dsw-alias-label-primary,#111);--npr-dim:var(--dsw-alias-label-tertiary,#6b6b70);`,
    `--npr-line:var(--dsw-alias-border-l2,rgba(0,0,0,.12));--npr-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));`,
    `--npr-accent:var(--dsw-alias-brand-primary,#2f6feb);--npr-danger:var(--dsw-alias-state-error-primary,#c0392b);`,
    `--npr-warn:var(--dsw-alias-state-warn-primary,#b8860b);--npr-ok:var(--dsw-alias-state-success-primary,#2e7d32);`,
    `font:400 13px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;color:var(--npr-fg);}`,

    `.npr-navrow{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;`,
    `margin:1px 0;padding:6px 8px;border:0;border-radius:8px;background:transparent;`,
    `font:inherit;color:inherit;text-align:left;cursor:pointer;}`,
    `.npr-navrow:hover{background:var(--npr-hover);}`,
    `.npr-navrow svg{flex:0 0 auto;width:16px;height:16px;opacity:.75;}`,
    `.npr-navrow span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}`,
    `.npr-navrow.npr-rail{justify-content:center;gap:0;padding:6px 0;}`,
    `.npr-navrow.npr-rail span{display:none;}`,

    `.npr-chip{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;gap:8px;}`,
    `.npr-chip button{border:1px solid var(--npr-line);background:var(--npr-bg);color:inherit;`,
    `border-radius:999px;padding:6px 12px;font:inherit;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.12);}`,

    `.npr-root{position:fixed;inset:0;z-index:2147483200;display:flex;align-items:center;`,
    `justify-content:center;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.35));}`,
    `.npr-root[hidden]{display:none;}`,
    `.npr-panel{display:flex;flex-direction:column;width:min(760px,94vw);height:min(780px,90vh);`,
    `background:var(--npr-bg);border:1px solid var(--npr-line);border-radius:14px;overflow:hidden;`,
    `box-shadow:0 24px 70px rgba(0,0,0,.35);}`,
    `.npr-head{display:flex;align-items:baseline;gap:12px;padding:16px 18px;border-bottom:1px solid var(--npr-line);}`,
    `.npr-head h2{margin:0;font-size:15px;font-weight:600;}`,
    `.npr-head .npr-dim{color:var(--npr-dim);font-size:12px;}`,
    `.npr-head .npr-spacer{flex:1;}`,
    `.npr-body{flex:1;overflow:auto;padding:16px 18px;}`,
    `.npr-foot{padding:10px 18px;border-top:1px solid var(--npr-line);color:var(--npr-dim);font-size:12px;}`,
    `.npr-foot:empty{display:none;}`,

    `.npr-btn{border:1px solid var(--npr-line);background:var(--npr-bg2);color:inherit;border-radius:8px;`,
    `padding:6px 12px;font:inherit;cursor:pointer;}`,
    `.npr-btn:hover{background:var(--npr-hover);}`,
    `.npr-btn[disabled]{opacity:.45;cursor:default;}`,
    `.npr-btn.npr-primary{background:var(--dsw-alias-button-primary-fill,#2f6feb);`,
    `border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff);}`,
    `.npr-btn.npr-danger{color:#fff;background:var(--npr-danger);border-color:transparent;}`,
    `.npr-btn.npr-small{padding:4px 9px;font-size:12px;}`,
    `.npr-btn.npr-quiet{background:transparent;border-color:transparent;color:var(--npr-dim);`,
    `text-decoration:underline;padding:4px 6px;font-size:12px;}`,
    `.npr-btn.npr-quiet:hover{color:var(--npr-fg);background:transparent;}`,

    `.npr-h3{margin:20px 0 8px;font-size:13px;font-weight:600;}`,
    `.npr-h3:first-child{margin-top:0;}`,
    `.npr-card{border:1px solid var(--npr-line);border-radius:12px;padding:14px;background:var(--npr-bg2);}`,
    `.npr-card h4{margin:0 0 2px;font-size:14px;font-weight:600;}`,
    `.npr-card .npr-sub{color:var(--npr-dim);font-size:11.5px;}`,
    `.npr-open{margin:14px 0 4px;}`,

    `.npr-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;}`,
    `.npr-item{border:1px solid var(--npr-line);border-radius:12px;padding:12px 14px;}`,
    `.npr-item.npr-current{border-color:var(--npr-accent);}`,
    `.npr-item-head{display:flex;align-items:baseline;gap:8px;}`,
    `.npr-item-head b{font-size:13.5px;font-weight:600;overflow-wrap:anywhere;}`,
    `.npr-item-head .npr-spacer{flex:1;}`,
    `.npr-path{display:block;color:var(--npr-dim);font-size:11px;word-break:break-all;`,
    `font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);margin-top:3px;}`,
    `.npr-meta{display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;color:var(--npr-dim);font-size:11.5px;}`,
    `.npr-meta b{color:var(--npr-fg);font-weight:500;font-variant-numeric:tabular-nums;}`,
    `.npr-actions{display:flex;gap:6px;align-items:center;margin-top:10px;flex-wrap:wrap;}`,
    `.npr-actions .npr-spacer{flex:1;}`,

    `.npr-caps{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:4px;}`,
    `.npr-caps li{display:flex;align-items:center;gap:8px;font-size:12.5px;}`,
    `.npr-caps .npr-spacer{flex:1;}`,
    `.npr-cap-state{font-size:11px;border:1px solid var(--npr-line);border-radius:999px;padding:0 8px;color:var(--npr-dim);}`,
    `.npr-cap-state.npr-on{color:var(--npr-ok);border-color:var(--npr-ok);}`,
    `.npr-cap-state.npr-off{color:var(--npr-dim);}`,

    `.npr-auths{margin-top:16px;padding-top:12px;border-top:1px solid var(--npr-line);}`,
    `.npr-auths .npr-h4{margin:0;}`,
    `.npr-cap-edit{flex:0 0 auto;}`,
    `.npr-hint{margin:10px 0 0;color:var(--npr-dim);font-size:11.5px;line-height:1.5;}`,

    `.npr-tag{display:inline-block;padding:1px 7px;border-radius:999px;border:1px solid var(--npr-line);`,
    `font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--npr-dim);white-space:nowrap;}`,
    `.npr-tag.npr-on{color:var(--npr-ok);border-color:var(--npr-ok);}`,
    `.npr-tag.npr-warn{color:var(--npr-warn);border-color:var(--npr-warn);}`,

    `.npr-note{margin:10px 0;padding:10px 12px;border-radius:10px;border:1px solid var(--npr-line);`,
    `background:var(--npr-bg2);white-space:pre-wrap;}`,
    `.npr-note.npr-error{border-color:var(--npr-danger);color:var(--npr-danger);}`,
    `.npr-note.npr-warn{border-color:var(--npr-warn);color:var(--npr-warn);}`,
    `.npr-note.npr-ok{border-color:var(--npr-ok);color:var(--npr-ok);}`,

    `.npr-kv{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;margin:12px 0;}`,
    `.npr-kv dt{color:var(--npr-dim);}`,
    `.npr-kv dd{margin:0;word-break:break-word;}`,
    `.npr-kv dd.npr-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;}`,
    `.npr-empty{margin:20px auto;max-width:60ch;text-align:center;color:var(--npr-dim);}`,
    `.npr-row{display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap;}`,

    `.npr-git{margin-top:18px;padding-top:14px;border-top:1px solid var(--npr-line);}`,
    `.npr-git .npr-h3{margin-top:0;}`,
    `.npr-git .npr-kv{margin:8px 0 4px;}`,
    `.npr-git .npr-list{margin-top:10px;}`,
    `.npr-file{padding:8px 10px;border-radius:10px;}`,
    `.npr-file .npr-item-head b{font-size:11.5px;font-weight:500;word-break:break-all;`,
    `font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);}`,
    `.npr-counts{font-variant-numeric:tabular-nums;font-size:11.5px;white-space:nowrap;}`,
    `.npr-add{color:var(--npr-ok);}`,
    `.npr-del{color:var(--npr-danger);}`,
    `.npr-diff{margin:8px 0 2px;padding:10px;border:1px solid var(--npr-line);border-radius:8px;`,
    `background:var(--npr-bg);max-height:280px;overflow:auto;white-space:pre-wrap;word-break:break-word;`,
    `font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;}`,
    `.npr-commit-row{display:flex;align-items:center;gap:8px;font-size:12.5px;word-break:break-all;}`,
    `.npr-commit-row input{flex:0 0 auto;}`,
    `.npr-message{display:block;width:100%;box-sizing:border-box;margin-top:10px;padding:8px;`,
    `border:1px solid var(--npr-line);border-radius:8px;background:var(--npr-bg);color:inherit;`,
    `font:inherit;resize:vertical;}`,
    `.npr-git .npr-foot{padding:0;border:0;margin-top:8px;}`,
  ].join('');
}

/**
 * The whole client side of the section.
 *
 * Self-contained on purpose: it closes over nothing, so it can be serialised
 * with `toString()` and shipped to the page. The test suite runs this very
 * function against a fake DOM.
 */
export function clientProjects() {
  var FACTS = FACTS_JSON;
  var SEATS = SEAT_NAMES;
  var RAIL_WIDTH = RAIL_PIXELS;
  var CAPABILITY_LABELS = CAPABILITY_LABELS_JSON;
  var CAPABILITY_ORDER = CAPABILITY_ORDER_JSON;

  /** What each Git change is called on screen. */
  var KIND_LABELS = {
    modified: 'modifié',
    added: 'ajouté',
    deleted: 'supprimé',
    renamed: 'renommé',
    typechange: 'type changé',
    untracked: 'nouveau',
    conflicted: 'conflit',
  };

  /** What each synchronisation NewPi performed is called on screen. */
  var SYNC_LABELS = { fetch: 'vérification', push: 'envoi', pull: 'mise à jour' };

  /** How an operation Git left unfinished is explained, without jargon. */
  var PROGRESS_LABELS = {
    merge: 'une fusion est en cours et n\'est pas terminée',
    rebase: 'un rebasage est en cours',
    'cherry-pick': 'un cherry-pick est en cours',
    revert: 'une annulation est en cours',
    bisect: 'une recherche de régression est en cours',
    locked: 'une autre commande Git est en cours',
  };

  /**
   * The words one modifiable capability is asked for with.
   *
   * The list of capabilities that may be changed comes from the server (see
   * `FACTS.editableCapabilities`); this table only says how to talk about the
   * one V1 opens. An unknown name falls back to a sentence built from its
   * label, so a capability added server side still renders a real control.
   */
  var CAPABILITY_ACTIONS = {
    network: {
      grant: 'Autoriser le réseau…',
      grantTitle: 'Autoriser le réseau',
      revoke: "Retirer l'autorisation",
      revokeTitle: "Retirer l'autorisation réseau",
      hint:
        'Autoriser le réseau permet à ce projet de contacter des services externes, notamment ' +
        "d'envoyer ou de récupérer des changements GitHub. Le travail Git local reste disponible " +
        'même quand le réseau est refusé.',
      allows:
        'permet à ce projet de contacter des services externes, notamment d\'envoyer ou de récupérer ' +
        'des changements GitHub. Le travail Git local reste disponible dans tous les cas.',
      refuses:
        'empêche ce projet de contacter des services externes : les envois et les récupérations Git ' +
        'seront refusés à partir de maintenant. Le travail Git local reste disponible.',
    },
  };

  /** The words for one capability, generic when the table has none. */
  function capabilityAction(name) {
    if (CAPABILITY_ACTIONS[name]) return CAPABILITY_ACTIONS[name];
    var label = CAPABILITY_LABELS[name] || name;
    var lower = label.toLowerCase();
    return {
      grant: 'Autoriser ' + lower + '…',
      grantTitle: 'Autoriser ' + lower,
      revoke: "Retirer l'autorisation",
      revokeTitle: "Retirer l'autorisation " + lower,
      hint: 'Cette autorisation ouvre « ' + label + ' » à ce projet.',
      allows: 'autorise ce projet à utiliser « ' + label + ' ».',
      refuses: 'retire à ce projet l\'usage de « ' + label + ' ».',
    };
  }

  state = null;

  // ------------------------------------------------------------ transport

  /** Call one action of the Project Model's endpoint. */
  function call(action, params) {
    var endpoint = (FACTS && FACTS.endpoint) || '/api/newpi.project';
    return fetch(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: action, params: params || {} }),
    })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return { ok: false, error: { code: 'PROJECT_BAD_JSON', message: 'Réponse illisible.' } };
          })
          .then(function (payload) {
            if (!payload || payload.ok !== true) {
              var detail = (payload && payload.error) || {};
              var failure = new Error(detail.message || 'Échec de la requête.');
              failure.code = detail.code || 'PROJECT_FAILED';
              throw failure;
            }
            return payload.value;
          });
      })
      .catch(function (error) {
        throw error instanceof Error ? error : new Error(String(error));
      });
  }

  // --------------------------------------------------------------- helpers

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function button(className, text, onClick) {
    var node = el('button', className || 'npr-btn', text);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function tag(className, text) {
    return el('span', 'npr-tag' + (className ? ' ' + className : ''), text);
  }

  function notice(target, message, kind) {
    var note = el('div', 'npr-note' + (kind ? ' npr-' + kind : ''), message);
    target.body.appendChild(note);
    return note;
  }

  /** A date a person reads, or a dash when the model has none. */
  function when(value) {
    if (typeof value !== 'number' || !isFinite(value) || value <= 0) return '—';
    try {
      return new Date(value).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    } catch (error) {
      return '—';
    }
  }

  /** The icon the sidebar row shows, drawn as markup so it needs no request. */
  function icon() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.3');
    var folder = document.createElementNS(ns, 'path');
    folder.setAttribute('d', 'M1.8 4.2c0-.7.6-1.2 1.2-1.2h2.6l1.3 1.5h5.1c.7 0 1.2.6 1.2 1.2v6.1c0 .7-.6 1.2-1.2 1.2H3c-.7 0-1.2-.6-1.2-1.2z');
    var dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', '8');
    dot.setAttribute('cy', '9');
    dot.setAttribute('r', '1.6');
    svg.appendChild(folder);
    svg.appendChild(dot);
    return svg;
  }

  /**
   * The five capabilities, each with the word a person reads.
   *
   * A capability named by the server's editable list gets one control, and only
   * that one: the page renders what the model said may be changed, and asks for
   * the change by name. Everything else is shown, never offered.
   */
  function renderCapabilities(project, editable) {
    var settings = (project && project.settings) || {};
    var granted = settings.capabilities || {};
    var changeable = Array.isArray(editable) ? editable : [];
    var list = el('ul', 'npr-caps');
    CAPABILITY_ORDER.forEach(function (name) {
      var item = el('li');
      item.appendChild(el('span', null, CAPABILITY_LABELS[name] || name));
      item.appendChild(el('span', 'npr-spacer'));
      var on = granted[name] === true;
      item.appendChild(
        el('span', 'npr-cap-state ' + (on ? 'npr-on' : 'npr-off'), on ? 'autorisé' : 'refusé'),
      );
      if (changeable.indexOf(name) !== -1) {
        var words = capabilityAction(name);
        item.appendChild(
          button(
            on ? 'npr-btn npr-small npr-quiet' : 'npr-btn npr-small',
            on ? words.revoke : words.grant,
            (function (capability, next) {
              return function () {
                openCapabilityConfirm(project, capability, next);
              };
            })(name, !on),
          ),
        );
      }
      list.appendChild(item);
    });
    return list;
  }

  /**
   * The "Autorisations du projet" zone of the open project's card.
   *
   * It shows the five capabilities and, for each one the model allows an
   * interface to change, one control. The explanation comes from the same
   * words as the confirmation, so the zone and the confirmation can never
   * disagree about what a grant does.
   */
  function renderAuthorizations(card, project) {
    var zone = el('div', 'npr-auths');
    zone.setAttribute('data-newpi-authorizations', '');
    zone.appendChild(el('h4', 'npr-h4', 'Autorisations du projet'));
    var editable = (FACTS && FACTS.editableCapabilities) || [];
    zone.appendChild(renderCapabilities(project, editable));
    var hints = [];
    (Array.isArray(editable) ? editable : []).forEach(function (name) {
      var words = capabilityAction(name);
      if (words.hint && hints.indexOf(words.hint) === -1) hints.push(words.hint);
    });
    if (hints.length > 0) {
      zone.appendChild(el('p', 'npr-hint', hints.join(' ')));
    }
    card.appendChild(zone);
  }

  /** The readable line describing a project's folder and dates. */
  function renderMeta(project) {
    var meta = el('div', 'npr-meta');
    function pair(label, value) {
      var box = el('span');
      box.appendChild(document.createTextNode(label + ' '));
      box.appendChild(el('b', null, value));
      meta.appendChild(box);
    }
    pair("Dernière ouverture", when(project.lastOpenedAt));
    pair(
      'Dernière session connue',
      project.sessions && project.sessions.length > 0
        ? when(project.lastSessionAt)
        : 'aucune',
    );
    return meta;
  }

  // ------------------------------------------------------------------- git

  /** A note inside the Git zone, which does not own the panel's footer. */
  function gitNote(parent, message, kind) {
    var note = el('div', 'npr-note' + (kind ? ' npr-' + kind : ''), message);
    parent.appendChild(note);
    return note;
  }

  /** The `+n −m` (or "binaire") line of one file. */
  function countsLabel(file) {
    if (file.binary === true) return 'binaire';
    if (file.added === null && file.removed === null) return '';
    var text = '';
    if (typeof file.added === 'number' && file.added > 0) text += '+' + file.added;
    if (typeof file.removed === 'number' && file.removed > 0) {
      text += (text === '' ? '' : ' ') + '−' + file.removed;
    }
    return text;
  }

  /** The `+n` and `−m` as separate coloured spans. */
  function countsNode(file) {
    var box = el('span', 'npr-counts');
    if (file.binary === true) {
      box.appendChild(el('span', 'npr-dim', 'binaire'));
      return box;
    }
    if (typeof file.added === 'number' && file.added > 0) {
      box.appendChild(el('span', 'npr-add', '+' + file.added));
    }
    if (typeof file.removed === 'number' && file.removed > 0) {
      box.appendChild(el('span', 'npr-del', (box.children.length > 0 ? ' ' : '') + '−' + file.removed));
    }
    return box;
  }

  /** A button whose disabled state is decided by the state it acts on. */
  function gitAction(label, primary, disabled, onClick) {
    var node = button(primary ? 'npr-btn npr-primary' : 'npr-btn', label, onClick);
    node.disabled = disabled === true;
    return node;
  }

  /** The last synchronisation NewPi recorded, in words. */
  function lastSyncLabel(sync) {
    if (!sync || typeof sync.at !== 'number') return 'aucune connue';
    return (SYNC_LABELS[sync.kind] || 'synchronisation') + ' le ' + when(sync.at);
  }

  /** Whether a mutating Git action is possible right now. */
  function gitBusy(status) {
    return status.inProgress !== null || status.conflicted === true;
  }

  /**
   * The whole Git zone, from one status snapshot.
   *
   * `status` is `null` while the state is being read; `feedback` carries the
   * answer of the action that just ran, and its optional follow-up button.
   */
  function renderGit(box, status, feedback) {
    box.textContent = '';
    box.appendChild(el('h3', 'npr-h3', 'Historique Git'));
    if (feedback && feedback.message) {
      gitNote(box, feedback.message, feedback.kind || null).setAttribute('data-newpi-git-feedback', '');
    }
    if (!status) {
      if (!feedback) gitNote(box, 'Lecture de l\'état Git…');
      return;
    }
    if (status.repo !== true) {
      gitNote(
        box,
        "Aucun dépôt Git détecté dans ce dossier. NewPi ne crée pas de dépôt à votre place : " +
          'initialisez-en un (`git init`) si vous voulez suivre ce projet.',
      );
      return;
    }
    if (status.usable !== true) {
      gitNote(box, (status.blocked && status.blocked.message) || 'Ce dépôt Git ne peut pas être utilisé ici.', 'warn');
      return;
    }

    var kv = el('dl', 'npr-kv');
    function pair(term, value) {
      kv.appendChild(el('dt', null, term));
      kv.appendChild(el('dd', null, value));
    }
    pair('Branche', status.branch === null ? 'détachée (aucune branche)' : status.branch);
    pair(
      'Dépôt distant',
      status.remote
        ? status.remote.name + (status.remote.url ? ' — ' + status.remote.url : '')
        : 'aucun dépôt distant configuré',
    );
    pair('Fichiers modifiés', String(status.counts.files));
    pair('Commits locaux en attente', String(status.ahead));
    pair('Nouveautés du distant', status.upstream === null ? 'suivi de branche inconnu' : String(status.behind));
    pair('Dernière synchronisation', lastSyncLabel(status.lastSync));
    box.appendChild(kv);

    if (status.inProgress !== null) {
      gitNote(
        box,
        'NewPi s\'arrête ici : ' +
          (PROGRESS_LABELS[status.inProgress] || 'une opération Git est en cours') +
          '. Terminez-la ou annulez-la dans un terminal, puis revenez ici. Rien n\'a été forcé.',
        'warn',
      );
    }
    if (status.conflicted === true) {
      gitNote(
        box,
        'Des fichiers sont en conflit et ne sont pas résolus. NewPi ne choisit pas à votre place. ' +
          'Résolvez le conflit dans un éditeur, puis enregistrez une étape.',
        'warn',
      );
    } else if (status.diverged === true) {
      gitNote(
        box,
        'Les histoires ont divergé : ' +
          status.ahead +
          ' commit(s) local(aux) et ' +
          status.behind +
          ' sur le distant. NewPi ne fusionne jamais automatiquement : faites la fusion vous-même ' +
          'dans un terminal, puis revenez ici.',
        'warn',
      );
    }

    // Local work stays available; the two remote actions need the project's
    // network reach, and the zone says so instead of leaving a dead button.
    var offline = status.networkAllowed !== true;
    if (offline) {
      gitNote(
        box,
        'Le travail local reste possible. Pour envoyer ou récupérer, le réseau de ce projet doit être ' +
          'autorisé (capacité « Réseau »).',
        'warn',
      );
    }

    var actions = el('div', 'npr-row');
    var blocked = gitBusy(status);
    actions.appendChild(
      gitAction('Enregistrer une étape', true, blocked || status.files.length === 0, function () {
        renderCommitView(box, status, null);
      }),
    );
    var canPush =
      blocked === false &&
      !offline &&
      status.remote !== null &&
      status.branch !== null &&
      status.diverged !== true &&
      (status.ahead > 0 || status.upstream === null);
    actions.appendChild(
      gitAction('Envoyer sur GitHub', false, !canPush, function () {
        renderPushView(box, status);
      }),
    );
    var canFetch =
      status.inProgress === null && !offline && status.remote !== null && status.branch !== null;
    actions.appendChild(
      gitAction('Récupérer les nouveautés', false, !canFetch, function () {
        runFetch(box);
      }),
    );
    if (feedback && feedback.action) {
      actions.appendChild(gitAction(feedback.action.label, true, false, feedback.action.run));
    }
    box.appendChild(actions);

    if (status.files.length === 0) {
      box.appendChild(
        el('div', 'npr-dim', 'Aucun fichier modifié : la copie de travail correspond au dernier commit.'),
      );
    } else {
      var list = el('ul', 'npr-list');
      status.files.forEach(function (file) {
        list.appendChild(renderGitFile(file, status));
      });
      box.appendChild(list);
    }

    if (status.lastCommit) {
      box.appendChild(
        el(
          'div',
          'npr-sub',
          'Dernier commit : ' +
            status.lastCommit.shortId +
            ' — ' +
            status.lastCommit.subject +
            ' (' +
            when(status.lastCommit.at) +
            ')',
        ),
      );
    }
  }

  /** One file row: its kind, its line counts, and a diff that opens on demand. */
  function renderGitFile(file, status) {
    var item = el('li', 'npr-item npr-file');
    var head = el('div', 'npr-item-head');
    head.appendChild(el('b', null, file.path));
    head.appendChild(el('span', 'npr-spacer'));
    head.appendChild(el('span', 'npr-dim', KIND_LABELS[file.kind] || file.kind));
    head.appendChild(countsNode(file));
    item.appendChild(head);
    if (file.originalPath) item.appendChild(el('span', 'npr-sub', 'depuis ' + file.originalPath));

    var row = el('div', 'npr-actions');
    row.appendChild(
      button('npr-btn npr-small', 'Voir le diff', function () {
        toggleDiff(item, file, status);
      }),
    );
    item.appendChild(row);
    return item;
  }

  /** Open or close the readable diff of one file. */
  function toggleDiff(item, file, status) {
    var existing = null;
    for (var index = 0; index < item.children.length; index += 1) {
      if (item.children[index].className === 'npr-diff') existing = item.children[index];
    }
    if (existing) {
      item.removeChild(existing);
      return;
    }
    var pre = el('pre', 'npr-diff', 'Lecture du diff…');
    item.appendChild(pre);
    var area = file.unstaged === true || file.kind === 'untracked' ? 'work' : 'index';
    call('project.git.diff', { path: file.path, area: area })
      .then(function (diff) {
        pre.textContent = diff.text === '' ? 'Aucun changement lisible pour ce fichier.' : diff.text;
        if (diff.truncated === true) {
          item.appendChild(
            el('div', 'npr-sub', 'Diff tronqué : il est trop long pour être affiché en entier.'),
          );
        }
      })
      .catch(function (error) {
        pre.textContent = 'Le diff est illisible : ' + error.message;
      });
  }

  /** Read the Git state and render the zone. */
  function loadGit(box) {
    var token = (state.gitToken || 0) + 1;
    state.gitToken = token;
    renderGit(box, null, null);
    call('project.git.status')
      .then(function (status) {
        if (state.gitToken !== token) return;
        state.gitStatus = status;
        state.gitBox = box;
        renderGit(box, status, null);
      })
      .catch(function (error) {
        if (state.gitToken !== token) return;
        state.gitStatus = null;
        // The model's capability refusal names the project by its internal id;
        // the zone says the same thing in words a person reads instead.
        var message =
          error.code === 'PROJECT_CAPABILITY_DENIED'
            ? 'Git est refusé pour ce projet : la capacité « Git » ne lui est pas accordée.'
            : 'L\'état Git est illisible : ' + error.message;
        renderGit(box, null, { message: message, kind: 'error' });
      });
  }

  /** The "Enregistrer une étape" screen: pick files, write the message. */
  function renderCommitView(box, status, feedback) {
    box.textContent = '';
    box.appendChild(el('h3', 'npr-h3', 'Enregistrer une étape'));
    if (feedback && feedback.message) gitNote(box, feedback.message, feedback.kind || null);
    gitNote(
      box,
      'Choisissez les fichiers, écrivez un message : le commit est créé dans le dépôt local. ' +
        'Rien n\'est envoyé sur le distant.',
    );
    var draft = state.gitDraft || { message: '', paths: null };
    var list = el('ul', 'npr-caps');
    var boxes = [];
    status.files.forEach(function (file) {
      var item = el('li');
      var input = el('input');
      input.type = 'checkbox';
      input.checked = draft.paths === null ? true : draft.paths.indexOf(file.path) !== -1;
      input.setAttribute('data-git-path', file.path);
      var label = el('label', 'npr-commit-row');
      label.appendChild(input);
      label.appendChild(el('span', null, file.path + (countsLabel(file) ? '  ' + countsLabel(file) : '')));
      item.appendChild(label);
      list.appendChild(item);
      boxes.push(input);
    });
    box.appendChild(list);

    var area = el('textarea', 'npr-message');
    area.setAttribute('placeholder', 'Décrivez ce que cette étape apporte');
    area.rows = 3;
    area.value = draft.message || '';
    box.appendChild(area);

    var errors = el('div', 'npr-foot');
    box.appendChild(errors);

    var row = el('div', 'npr-row');
    row.appendChild(
      button('npr-btn npr-primary', 'Créer le commit local', function () {
        runCommit(box, status, boxes, area, errors);
      }),
    );
    row.appendChild(
      button('npr-btn', 'Annuler', function () {
        state.gitDraft = null;
        renderGit(box, status, null);
      }),
    );
    box.appendChild(row);
  }

  /** Create the local commit from what the screen holds. */
  function runCommit(box, status, boxes, area, errors) {
    var paths = [];
    boxes.forEach(function (input) {
      if (input.checked === true) paths.push(input.getAttribute('data-git-path'));
    });
    var message = String(area.value || '').trim();
    state.gitDraft = { message: message, paths: paths };
    errors.textContent = '';
    if (paths.length === 0) {
      gitNote(errors, 'Choisissez au moins un fichier à enregistrer.', 'warn');
      return;
    }
    if (message === '') {
      gitNote(errors, 'Écrivez un message pour cette étape.', 'warn');
      return;
    }
    box.textContent = '';
    box.appendChild(el('h3', 'npr-h3', 'Enregistrer une étape'));
    gitNote(box, 'Création du commit local…');
    call('project.git.commit', { message: message, paths: paths })
      .then(function (result) {
        state.gitDraft = null;
        state.gitStatus = result.status;
        renderGit(box, result.status, {
          message:
            'Étape enregistrée : ' +
            result.commit.shortId +
            ' — ' +
            result.commit.subject +
            '. Elle n\'est pas encore sur le distant.',
          kind: 'ok',
        });
      })
      .catch(function (error) {
        state.gitStatus = status;
        renderCommitView(box, status, {
          message: 'Le commit n\'a pas été créé : ' + error.message,
          kind: 'error',
        });
      });
  }

  /** The "Envoyer sur GitHub" confirmation. */
  function renderPushView(box, status) {
    box.textContent = '';
    box.appendChild(el('h3', 'npr-h3', 'Envoyer sur GitHub'));
    var remote = status.remote ? status.remote.name : 'le dépôt distant';
    var waiting =
      status.upstream === null
        ? 'Les commits de la branche « ' + status.branch + ' »'
        : status.ahead + ' commit(s) local(aux) de la branche « ' + status.branch + ' »';
    gitNote(
      box,
      waiting +
        ' seront envoyés vers « ' +
        remote +
        ' ». Rien d\'autre n\'est modifié, et un envoi forcé n\'est pas possible depuis NewPi.',
      'warn',
    );
    var row = el('div', 'npr-row');
    row.appendChild(
      button('npr-btn npr-primary', 'Envoyer', function () {
        runPush(box);
      }),
    );
    row.appendChild(
      button('npr-btn', 'Annuler', function () {
        renderGit(box, status, null);
      }),
    );
    box.appendChild(row);
  }

  /** Push the local commits, and report exactly what happened. */
  function runPush(box) {
    box.textContent = '';
    box.appendChild(el('h3', 'npr-h3', 'Envoyer sur GitHub'));
    gitNote(box, 'Envoi des commits locaux…');
    call('project.git.push')
      .then(function (result) {
        state.gitStatus = result.status;
        renderGit(box, result.status, {
          message: 'Envoi effectué vers « ' + result.remote.name + ' » (' + result.branch + ').',
          kind: 'ok',
        });
      })
      .catch(function (error) {
        renderGit(box, state.gitStatus, {
          message: 'L\'envoi n\'a pas été fait : ' + error.message,
          kind: 'error',
        });
      });
  }

  /** Ask the remote what it has, and offer an update only when it is a fast-forward. */
  function runFetch(box) {
    box.textContent = '';
    box.appendChild(el('h3', 'npr-h3', 'Historique Git'));
    gitNote(box, 'Vérification de ce qui existe sur le dépôt distant…');
    call('project.git.fetch')
      .then(function (result) {
        var status = result.status;
        state.gitStatus = status;
        if (status.behind === 0) {
          return renderGit(box, status, {
            message: 'Le projet est déjà à jour avec le distant.',
            kind: 'ok',
          });
        }
        if (status.diverged === true) {
          return renderGit(box, status, {
            message:
              'Le distant a ' +
              status.behind +
              ' commit(s) que vous n\'avez pas, et vous avez ' +
              status.ahead +
              ' commit(s) qu\'il n\'a pas. NewPi ne fusionne pas : aucune mise à jour n\'est proposée.',
            kind: 'warn',
          });
        }
        if (status.fastForward === true) {
          return renderGit(box, status, {
            message: status.behind + ' nouveauté(s) peuvent être appliquées sans fusion (avance rapide).',
            kind: 'warn',
            action: {
              label: 'Mettre à jour (avance rapide)',
              run: function () {
                runPull(box);
              },
            },
          });
        }
        return renderGit(box, status, {
          message:
            'Les nouveautés du distant ne peuvent pas être appliquées en avance rapide. ' +
            'NewPi ne force rien : regardez la situation dans un terminal.',
          kind: 'warn',
        });
      })
      .catch(function (error) {
        renderGit(box, state.gitStatus, {
          message: 'La récupération a échoué : ' + error.message,
          kind: 'error',
        });
      });
  }

  /** The only update NewPi performs: a fast-forward, and nothing else. */
  function runPull(box) {
    box.textContent = '';
    box.appendChild(el('h3', 'npr-h3', 'Historique Git'));
    gitNote(box, 'Mise à jour par avance rapide…');
    call('project.git.pull')
      .then(function (result) {
        state.gitStatus = result.status;
        renderGit(box, result.status, {
          message: result.updated
            ? 'Mise à jour effectuée : la branche a avancé sans fusion.'
            : 'Le projet était déjà à jour.',
          kind: 'ok',
        });
      })
      .catch(function (error) {
        renderGit(box, state.gitStatus, {
          message: 'La mise à jour n\'a pas été faite : ' + error.message,
          kind: 'error',
        });
      });
  }

  // ----------------------------------------------------------------- shell

  function ensurePanel() {
    if (state) return state;
    var root = el('div', 'npr-root');
    root.setAttribute('data-newpi-projects', '');
    root.hidden = true;

    var panel = el('div', 'npr-panel');
    var head = el('div', 'npr-head');
    head.appendChild(el('h2', null, 'Projets'));
    var summary = el('span', 'npr-dim', '');
    head.appendChild(summary);
    head.appendChild(el('span', 'npr-spacer'));
    head.appendChild(
      button('npr-btn', 'Fermer', function () {
        root.hidden = true;
      }),
    );

    var body = el('div', 'npr-body');
    var foot = el(
      'div',
      'npr-foot',
      "Retirer un projet de la liste ne supprime ni son dossier, ni ses sessions, ni sa mémoire.",
    );
    panel.appendChild(head);
    panel.appendChild(body);
    panel.appendChild(foot);
    root.appendChild(panel);
    document.body.appendChild(root);

    root.addEventListener('click', function (event) {
      if (event.target === root) root.hidden = true;
    });

    state = {
      root: root,
      body: body,
      foot: foot,
      summary: summary,
      data: null,
      busy: false,
      target: null,
      gitStatus: null,
      gitBox: null,
      gitToken: 0,
      gitDraft: null,
    };
    return state;
  }

  function closePanel() {
    if (state) state.root.hidden = true;
  }

  // ------------------------------------------------------------- rendering

  function renderOpenProject(current) {
    state.body.appendChild(el('h3', 'npr-h3', 'Projet ouvert'));
    if (!current) {
      var empty = el('div', 'npr-empty');
      empty.appendChild(el('div', null, "Aucun projet n'est ouvert."));
      empty.appendChild(
        el('div', null, 'Choisissez un dossier de projet pour commencer, ou rouvrez un projet récent.'),
      );
      state.body.appendChild(empty);
      return;
    }

    var card = el('div', 'npr-card');
    var head = el('div', 'npr-item-head');
    head.appendChild(el('b', null, current.name));
    head.appendChild(el('span', 'npr-spacer'));
    if (current.detached === true) {
      head.appendChild(tag('npr-warn', 'en attente de redémarrage'));
    } else {
      head.appendChild(tag('npr-on', 'ouvert'));
    }
    card.appendChild(head);
    card.appendChild(el('span', 'npr-path', current.rootPath));
    card.appendChild(renderMeta(current));
    renderAuthorizations(card, current);
    var gitBox = el('div', 'npr-git');
    card.appendChild(gitBox);
    state.body.appendChild(card);
    loadGit(gitBox);

    if (current.detached === true) {
      renderRestart(state, current);
    }
  }

  function renderRestart(target, project) {
    var launch = (FACTS && FACTS.launchRoot) || null;
    var note = notice(
      target,
      "Ce projet est enregistré comme dernier projet, mais le moteur travaille encore dans " +
        (launch || "l'ancien dossier") +
        '. NewPi doit redémarrer sur ' +
        project.rootPath +
        ' pour y travailler vraiment.',
      'warn',
    );
    note.setAttribute('data-newpi-restart-note', '');
    var row = el('div', 'npr-row');
    if (FACTS && FACTS.relaunch === true) {
      row.appendChild(
        button('npr-btn npr-primary', 'Redémarrer NewPi', function () {
          runRestart(target);
        }),
      );
    } else {
      row.appendChild(
        el(
          'span',
          'npr-dim',
          'NewPi ne tourne pas depuis une application : quittez le puis rouvrez le, le dernier projet choisi sera repris.',
        ),
      );
    }
    target.body.appendChild(row);
  }

  function renderRecentList(current, recent) {
    state.body.appendChild(el('h3', 'npr-h3', 'Projets récents'));
    if (!recent || recent.length === 0) {
      var empty = el('div', 'npr-empty');
      empty.appendChild(el('div', null, 'Aucun projet récent.'));
      empty.appendChild(
        el('div', null, "Ouvrez un dossier de projet : il rejoindra cette liste et y restera d'un lancement à l'autre."),
      );
      state.body.appendChild(empty);
      return;
    }

    var list = el('ul', 'npr-list');
    recent.forEach(function (project) {
      var isCurrent = current !== null && project.id === current.id;
      var item = el('li', 'npr-item' + (isCurrent ? ' npr-current' : ''));

      var head = el('div', 'npr-item-head');
      head.appendChild(el('b', null, project.name));
      if (isCurrent) head.appendChild(tag('npr-on', 'projet ouvert'));
      item.appendChild(head);
      item.appendChild(el('span', 'npr-path', project.rootPath));
      item.appendChild(renderMeta(project));

      var actions = el('div', 'npr-actions');
      if (!isCurrent) {
        actions.appendChild(
          button('npr-btn npr-small', 'Changer de projet…', function () {
            openTarget(project);
          }),
        );
      } else {
        actions.appendChild(el('span', 'npr-dim', 'Vous travaillez déjà dans ce projet.'));
      }
      actions.appendChild(el('span', 'npr-spacer'));
      if (!isCurrent) {
        actions.appendChild(
          button('npr-btn npr-quiet', 'Retirer de la liste', function () {
            confirmForget(project);
          }),
        );
      }
      item.appendChild(actions);
      list.appendChild(item);
    });
    state.body.appendChild(list);
  }

  function renderAll(data, feedback) {
    state.data = data;
    state.body.textContent = '';
    if (feedback && feedback.message) {
      notice(state, feedback.message, feedback.kind || null);
    }
    var current = data.current || null;
    var recent = data.recent || [];

    state.summary.textContent = current ? current.name : 'aucun projet ouvert';
    renderOpenProject(current);

    var row = el('div', 'npr-row');
    row.appendChild(
      button('npr-btn npr-primary', 'Ouvrir un dossier de projet…', function () {
        openPicker();
      }),
    );
    row.appendChild(
      button('npr-btn npr-small', 'Actualiser', function () {
        refresh();
      }),
    );
    state.body.appendChild(row);

    renderRecentList(current, recent);
  }

  function renderMessage(message, kind) {
    state.body.textContent = '';
    notice(state, message, kind);
    state.body.appendChild(
      button('npr-btn', '← Retour', function () {
        refresh();
      }),
    );
  }

  // --------------------------------------------------------------- actions

  function refresh(feedback) {
    if (state.busy) return;
    state.busy = true;
    state.body.textContent = '';
    notice(state, 'Lecture des projets…');
    Promise.all([call('project.current'), call('project.list')])
      .then(function (values) {
        state.busy = false;
        renderAll({ current: values[0] || null, recent: values[1] || [] }, feedback);
      })
      .catch(function (error) {
        state.busy = false;
        renderMessage('Les projets sont illisibles : ' + error.message, 'error');
      });
  }

  /**
   * The explicit confirmation one capability change needs.
   *
   * It names the project and says, in words, what the grant or the removal
   * does. Nothing is written until the confirming button is pressed, and
   * "Annuler" re-reads the panel without calling the model at all.
   */
  function openCapabilityConfirm(project, name, allowed) {
    var words = capabilityAction(name);
    var label = CAPABILITY_LABELS[name] || name;
    state.body.textContent = '';
    state.body.appendChild(el('h3', 'npr-h3', allowed ? words.grantTitle : words.revokeTitle));

    var kv = el('dl', 'npr-kv');
    kv.appendChild(el('dt', null, 'Projet'));
    var who = el('dd');
    who.appendChild(el('div', null, project.name));
    who.appendChild(el('span', 'npr-path', project.rootPath));
    kv.appendChild(who);
    kv.appendChild(el('dt', null, 'Autorisation'));
    kv.appendChild(el('dd', null, label + (allowed ? ' : accorder' : ' : retirer')));
    state.body.appendChild(kv);

    notice(
      state,
      allowed
        ? 'Accorder « ' + label + " » à « " + project.name + " » " + words.allows +
          " Vous pourrez retirer cette autorisation à tout moment ; une opération déjà en cours n'est pas interrompue."
        : 'Retirer « ' + label + " » à « " + project.name + " » " + words.refuses +
          " Une opération déjà en cours n'est pas interrompue : le retrait s'applique aux opérations suivantes.",
      allowed ? null : 'warn',
    );

    var row = el('div', 'npr-row');
    row.appendChild(
      button(allowed ? 'npr-btn npr-primary' : 'npr-btn npr-danger', allowed ? words.grantTitle : words.revoke, function () {
        applyCapability(project, name, allowed);
      }),
    );
    row.appendChild(
      button('npr-btn', 'Annuler', function () {
        refresh();
      }),
    );
    state.body.appendChild(row);
  }

  /** Ask the model for the change, then re-read everything the change affects. */
  function applyCapability(project, name, allowed) {
    if (state.busy) return;
    state.busy = true;
    state.body.textContent = '';
    notice(state, allowed ? "Enregistrement de l'autorisation…" : 'Enregistrement du retrait…');
    // `confirm: true` is sent here and nowhere else: this function is only
    // reached from the confirming button of the screen above, and the model
    // checks the flag again, so a grant cannot happen without both.
    call('project.capability.set', { name: name, allowed: allowed, confirm: true })
      .then(function () {
        state.busy = false;
        state.data = null;
        // The whole panel is re-read, which is also what reloads the Git zone:
        // the remote buttons come from the status the model now answers with.
        refresh({
          message: allowed
            ? 'Réseau autorisé pour « ' + project.name + ' ». Les envois et les récupérations Git sont maintenant possibles.'
            : 'Autorisation réseau retirée pour « ' + project.name + ' ». Les envois et les récupérations Git seront refusés à partir de maintenant.',
          kind: 'ok',
        });
      })
      .catch(function (error) {
        state.busy = false;
        state.body.textContent = '';
        if (error.code === 'PROJECT_BUSY') {
          notice(
            state,
            "L'autorisation n'a pas été changée : une opération est en cours. " +
              "Attendez qu'elle se termine, puis réessayez. Rien n'a été modifié.",
            'warn',
          );
        } else {
          notice(state, "Le changement d'autorisation a échoué : " + error.message, 'error');
        }
        state.body.appendChild(
          button('npr-btn', '← Retour', function () {
            refresh();
          }),
        );
      });
  }

  /** The native panel, then the same confirmation a recent project gets. */
  function openPicker() {
    if (state.busy) return;
    state.busy = true;
    state.body.textContent = '';
    notice(state, 'Le sélecteur de dossier va s\'ouvrir…');
    call('project.chooseFolder')
      .then(function (picked) {
        state.busy = false;
        if (!picked || picked.cancelled === true) {
          state.body.textContent = '';
          notice(state, 'Aucun dossier choisi.', 'warn');
          state.body.appendChild(
            button('npr-btn', '← Retour', function () {
              refresh();
            }),
          );
          return;
        }
        openTarget({
          id: null,
          name: picked.name,
          rootPath: picked.rootPath,
          known: picked.known === true,
        });
      })
      .catch(function (error) {
        state.busy = false;
        renderMessage("Le sélecteur de dossier n'a pas abouti : " + error.message, 'error');
      });
  }

  /**
   * Read the guard first, then ask. The Project Model refuses a switch while an
   * operation is in flight, and the panel shows that refusal instead of a
   * button that cannot work.
   */
  function openTarget(project) {
    state.busy = true;
    state.body.textContent = '';
    notice(state, 'Vérification des opérations en cours…');
    call('project.operations')
      .then(function (operations) {
        state.busy = false;
        var list = Array.isArray(operations) ? operations : [];
        if (list.length > 0) {
          renderBlocked(list, project);
          return;
        }
        renderConfirm(project);
      })
      .catch(function (error) {
        state.busy = false;
        renderMessage("L'état des opérations est illisible : " + error.message, 'error');
      });
  }

  function renderBlocked(operations, project) {
    state.body.textContent = '';
    state.target = project;
    var kinds = operations
      .map(function (operation) {
        return operation && operation.kind ? operation.kind : 'opération';
      })
      .join(', ');
    notice(
      state,
      'Une opération critique est en cours (' +
        kinds +
        '). Le changement de projet est refusé tant qu\'elle n\'est pas terminée, pour qu\'un travail en cours ne se termine pas dans un autre projet.',
      'warn',
    );
    var row = el('div', 'npr-row');
    row.appendChild(
      button('npr-btn', 'Vérifier à nouveau', function () {
        openTarget(project);
      }),
    );
    row.appendChild(
      button('npr-btn', '← Retour', function () {
        refresh();
      }),
    );
    state.body.appendChild(row);
  }

  function renderConfirm(project) {
    var current = state.data ? state.data.current : null;
    if (current && project.id && current.id === project.id) {
      renderMessage('Ce projet est déjà ouvert.', 'ok');
      return;
    }
    state.target = project;
    state.body.textContent = '';
    state.body.appendChild(el('h3', 'npr-h3', 'Changer de projet'));

    var kv = el('dl', 'npr-kv');
    function pair(term, name, path, mono) {
      kv.appendChild(el('dt', null, term));
      var dd = el('dd', mono ? 'npr-mono' : null);
      dd.appendChild(el('div', null, name));
      dd.appendChild(el('span', 'npr-path', path));
      kv.appendChild(dd);
    }
    pair('Projet actuel', current ? current.name : 'aucun', current ? current.rootPath : '—', false);
    pair('Projet cible', project.name, project.rootPath, true);
    state.body.appendChild(kv);

    if (current && current.sessions && current.sessions.length > 0) {
      notice(
        state,
        'Une session est rattachée à « ' +
          current.name +
          ' » ; elle restera rattachée à ce projet. Confirmez le changement pour continuer.',
        'warn',
      );
    }
    var sameRoot = current !== null && current.rootPath === project.rootPath;
    if (!sameRoot) {
      notice(
        state,
        'NewPi travaille dans ' +
          (((FACTS && FACTS.launchRoot) || (current ? current.rootPath : "l'ancien dossier"))) +
          '. Le projet choisi sera enregistré comme dernier projet ; le moteur changera de dossier au redémarrage de NewPi.',
      );
    }
    if (project.id === null || project.id === undefined) {
      notice(state, 'Ce dossier ne fait pas encore partie des projets connus : il sera ajouté à la liste.');
    }

    var row = el('div', 'npr-row');
    row.appendChild(
      button('npr-btn npr-primary', 'Changer de projet', function () {
        applySwitch(project);
      }),
    );
    row.appendChild(
      button('npr-btn', 'Annuler', function () {
        refresh();
      }),
    );
    state.body.appendChild(row);
  }

  function applySwitch(project) {
    if (state.busy) return;
    state.busy = true;
    state.body.textContent = '';
    notice(state, 'Changement de projet…');

    var prepared;
    if (project.id) {
      prepared = Promise.resolve(project);
    } else {
      prepared = call('project.create', { rootPath: project.rootPath, name: project.name });
    }

    prepared
      .then(function (record) {
        return call('project.open', { id: record.id });
      })
      .then(function (opened) {
        state.busy = false;
        state.data = null;
        renderAfterSwitch(opened);
      })
      .catch(function (error) {
        state.busy = false;
        state.body.textContent = '';
        if (error.code === 'PROJECT_BUSY') {
          notice(
            state,
            "Le projet n'a pas été changé : une opération est en cours. Attendez qu'elle se termine, puis réessayez.",
            'warn',
          );
        } else {
          notice(state, 'Le changement a échoué : ' + error.message, 'error');
        }
        state.body.appendChild(
          button('npr-btn', '← Retour', function () {
            refresh();
          }),
        );
      });
  }

  function renderAfterSwitch(opened) {
    state.body.textContent = '';
    state.body.appendChild(el('h3', 'npr-h3', 'Projet changé'));
    var card = el('div', 'npr-card');
    var head = el('div', 'npr-item-head');
    head.appendChild(el('b', null, opened.name));
    head.appendChild(el('span', 'npr-spacer'));
    head.appendChild(
      tag(opened.detached === true ? 'npr-warn' : 'npr-on', opened.detached === true ? 'redémarrage requis' : 'ouvert'),
    );
    card.appendChild(head);
    card.appendChild(el('span', 'npr-path', opened.rootPath));
    card.appendChild(renderMeta(opened));
    renderAuthorizations(card, opened);
    state.body.appendChild(card);

    notice(
      state,
      'Ce projet est enregistré comme dernier projet : le prochain lancement de NewPi le rouvrira.',
      'ok',
    );
    if (opened.detached === true) renderRestart(state, opened);

    state.body.appendChild(el('h3', 'npr-h3', 'Projets récents'));
    state.body.appendChild(el('div', 'npr-dim', 'Actualisez la liste pour la voir à jour.'));
    var row = el('div', 'npr-row');
    row.appendChild(
      button('npr-btn', '← Retour', function () {
        refresh();
      }),
    );
    state.body.appendChild(row);
  }

  function runRestart(project) {
    state.body.textContent = '';
    notice(state, 'NewPi redémarre sur ' + project.rootPath + '…');
    call('project.restart', { confirm: true })
      .then(function () {
        state.body.textContent = '';
        notice(
          state,
          'NewPi se ferme et se rouvre sur le projet choisi. Cette page disparaîtra avec lui.',
          'ok',
        );
      })
      .catch(function (error) {
        state.body.textContent = '';
        notice(state, 'Le redémarrage est impossible ici : ' + error.message, 'warn');
        state.body.appendChild(
          button('npr-btn', '← Retour', function () {
            refresh();
          }),
        );
      });
  }

  function confirmForget(project) {
    state.body.textContent = '';
    state.body.appendChild(el('h3', 'npr-h3', 'Retirer de la liste'));
    notice(
      state,
      '« ' +
        project.name +
        ' » sera retiré de la liste des projets récents (' +
        project.rootPath +
        '). Son dossier, ses sessions et sa mémoire ne sont pas touchés : rien n\'est supprimé sur le disque.',
      'warn',
    );
    var row = el('div', 'npr-row');
    row.appendChild(
      button('npr-btn npr-danger', 'Retirer de la liste', function () {
        runForget(project);
      }),
    );
    row.appendChild(
      button('npr-btn', 'Annuler', function () {
        refresh();
      }),
    );
    state.body.appendChild(row);
  }

  function runForget(project) {
    if (state.busy) return;
    state.busy = true;
    state.body.textContent = '';
    notice(state, 'Retrait de la liste…');
    call('project.forget', { id: project.id })
      .then(function () {
        state.busy = false;
        state.data = null;
        refresh();
      })
      .catch(function (error) {
        state.busy = false;
        renderMessage('Le retrait a échoué : ' + error.message, 'error');
      });
  }

  // ------------------------------------------------------------------- nav

  function openPanel() {
    var current = ensurePanel();
    current.root.hidden = false;
    if (current.data) {
      renderAll(current.data);
      return;
    }
    refresh();
  }

  /** The width of the box a seat sits in, or 0 when nothing is laid out yet. */
  function seatWidth(seat) {
    var node = seat;
    while (node && node.clientWidth === 0 && node.parentElement) node = node.parentElement;
    return node ? node.clientWidth : 0;
  }

  function adaptToRail(seat, node) {
    var width = seatWidth(seat);
    if (width > 0 && width < RAIL_WIDTH) node.classList.add('npr-rail');
    else node.classList.remove('npr-rail');
  }

  function installNav() {
    var seat = null;
    for (var index = 0; index < SEATS.length; index += 1) {
      seat = document.querySelector('[data-slot="' + SEATS[index] + '"]');
      if (seat) break;
    }
    if (!seat) return false;
    if (seat.querySelector('[data-newpi-projects-nav]')) return true;

    var node = button('npr-navrow', null, function () {
      openPanel();
    });
    node.setAttribute('data-newpi-projects-nav', '');
    node.setAttribute('title', 'Projets');
    node.setAttribute('aria-label', 'Projets');
    node.appendChild(icon());
    node.appendChild(el('span', null, 'Projets'));
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

  function installFallback() {
    if (document.querySelector('[data-newpi-projects-chip]')) return;
    if (!document.body) return;
    var chip = el('div', 'npr-chip');
    chip.setAttribute('data-newpi-projects-chip', '');
    chip.appendChild(
      button(null, 'Projets', function () {
        openPanel();
      }),
    );
    document.body.appendChild(chip);
  }

  function start() {
    try {
      window.addEventListener('keydown', function (event) {
        if (state && event.key === 'Escape' && !state.root.hidden) closePanel();
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
        window.console.error('newpi projects console: ' + error);
      }
    }
  }

  start();
}

/**
 * The script the page runs, as text.
 *
 * @param facts - the host facts inlined into the page.
 * @returns the script body, without its `<script>` wrapper.
 */
export function projectsScript(facts = {}) {
  // A function serialised with `toString` cannot close over a module constant,
  // so every table is substituted into its source before it is shipped.
  const source = clientProjects
    .toString()
    .replace('var FACTS = FACTS_JSON;', `var FACTS = ${JSON.stringify(facts)};`)
    .replace('var SEATS = SEAT_NAMES;', `var SEATS = ${JSON.stringify(NAV_SEATS)};`)
    .replace('var RAIL_WIDTH = RAIL_PIXELS;', `var RAIL_WIDTH = ${Number(RAIL_WIDTH)};`)
    .replace(
      'var CAPABILITY_LABELS = CAPABILITY_LABELS_JSON;',
      `var CAPABILITY_LABELS = ${JSON.stringify(CAPABILITY_LABELS)};`,
    )
    .replace(
      'var CAPABILITY_ORDER = CAPABILITY_ORDER_JSON;',
      `var CAPABILITY_ORDER = ${JSON.stringify(CAPABILITY_ORDER)};`,
    );
  return `(${source})();`;
}

/**
 * Inject the section into the rendered interface.
 *
 * A pure function of its input, as `tapIndex` requires: no state, no clock, no
 * I/O.
 *
 * @param html - the rendered `index.html` body.
 * @param facts - the host facts inlined into the page.
 * @returns the body with the section's style and script added.
 */
export function installProjects(html, facts = {}) {
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  const markup =
    `<style ${PROJECTS_ATTRIBUTE}>${projectsStyle()}</style>` +
    `<script ${PROJECTS_ATTRIBUTE}>${projectsScript(facts)}</script>`;
  if (head === null) return `${markup}${html}`;
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}${markup}${html.slice(at)}`;
}
