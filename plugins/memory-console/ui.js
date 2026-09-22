/**
 * The Memory and Backup sections, as the interface renders them.
 *
 * The two sections are injected into the interface the runtime serves, the same
 * way `newpi-brand` renames the product: one `<style>` and one `<script>`
 * spliced into the document head through `tapIndex`. Nothing is written to the
 * engine's files, no engine markup is rewritten, and the rows NewPi adds sit
 * inside the sidebar's own panel list — which is where a user looks for a
 * section.
 *
 * The client code below is a real function, not a string: it is syntax-checked
 * by the same tooling as the rest of the plugin, run for real against a fake
 * DOM in the test suite, and serialised into the page with
 * `Function.prototype.toString`. That is the one trick worth naming — a string
 * transform that has never been executed is a string transform that fails in
 * somebody's browser.
 *
 * Three rules the client code keeps, because it runs in a page that also
 * renders model output:
 *
 * - **No markup from data.** Every value read from PocketBase is written with
 *   `textContent`. The injected code never touches `innerHTML`.
 * - **No secret.** It knows one thing: the endpoint path. The project scope,
 *   the database URL and the credential all stay in the host process.
 * - **Never throw into the page.** Every entry point is wrapped: a section that
 *   cannot render itself says so in its own panel rather than breaking the
 *   interface around it.
 *
 * @module newpi-plugin-memory-console/ui
 */

/**
 * The sidebar seat the two rows are added to.
 *
 * Only the footer actions container, and that is a correction rather than a
 * preference. The rows used to try `sidebar.panellist` first, on the reading
 * that the engine's panel list is where a user looks for a section — and it
 * measured as *declared but not rendered* while nothing registers into it, so
 * the first seat never matched and the rows landed in the footer anyway.
 *
 * The file console changed that: it registers a real panel, the shell therefore
 * renders the panel list, and `[data-slot="sidebar.panellist"]` suddenly
 * existed — **inside the panel row's own glyph**, because that is where the
 * shell puts an occupant's component. Appending to it put Memory and Backup
 * inside the Files button: a 95-pixel row stacked in a 16-pixel glyph box,
 * reading as one label, with every click aimed at Files landing on Backup.
 *
 * The panel list is for components the shell is told about. An injected button
 * is not one, and the footer is where an injected button belongs.
 */
export const NAV_SEATS = ['sidebar.footer.action'];

/** The seat the fallback chain is anchored on, kept as its own export because
 * it is the one a test asserts against. */
export const PANELLIST_SLOT = 'sidebar.panellist';

/** Below this width the sidebar is a collapsed rail, and the rows show their
 * icon alone. It matches the width the engine's own rail collapses to (56px)
 * with room to spare, so the label never overflows a narrow seat. */
const RAIL_WIDTH = 120;

/** The marker attribute that makes the injected nodes recognisable. */
export const CONSOLE_ATTRIBUTE = 'data-newpi-console';

/** The two sections, in the order they are added to the sidebar. */
export const CONSOLE_SECTIONS = [
  { view: 'memory', label: 'Memory' },
  { view: 'backup', label: 'Backup' },
];

/**
 * The styling of both sections.
 *
 * Every colour is read from the interface's own theme variables with a literal
 * fallback, so the panel follows the light and dark themes without knowing
 * anything about them, and stays readable if a future engine renames them.
 *
 * @returns the CSS text.
 */
export function consoleStyle() {
  return [
    `[${CONSOLE_ATTRIBUTE}]{--npc-bg:var(--dsw-alias-bg-layer-1,#fff);--npc-bg2:var(--dsw-alias-bg-layer-2,#f6f6f7);`,
    `--npc-fg:var(--dsw-alias-label-primary,#111);--npc-dim:var(--dsw-alias-label-tertiary,#6b6b70);`,
    `--npc-line:var(--dsw-alias-border-l2,rgba(0,0,0,.12));--npc-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));`,
    `--npc-accent:var(--dsw-alias-brand-primary,#2f6feb);--npc-danger:var(--dsw-alias-state-error-primary,#c0392b);`,
    `--npc-warn:var(--dsw-alias-state-warn-primary,#b8860b);`,
    `font:400 13px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;color:var(--npc-fg);}`,

    // The sidebar rows: shaped like the engine's own, so the two NewPi entries
    // read as part of the navigation rather than as something bolted onto it.
    `.npc-navrow{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;`,
    `margin:1px 0;padding:6px 8px;border:0;border-radius:8px;background:transparent;`,
    `font:inherit;color:inherit;text-align:left;cursor:pointer;}`,
    `.npc-navrow:hover{background:var(--npc-hover);}`,
    `.npc-navrow svg{flex:0 0 auto;width:16px;height:16px;opacity:.75;}`,
    `.npc-navrow span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}`,
    // The collapsed rail keeps the icon and drops the label, as the engine's own
    // footer rows do.
    `.npc-navrow.npc-rail{justify-content:center;gap:0;padding:6px 0;}`,
    `.npc-navrow.npc-rail span{display:none;}`,

    // The fallback, when the sidebar never renders a list to attach to.
    `.npc-chip{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;gap:8px;}`,
    `.npc-chip button{border:1px solid var(--npc-line);background:var(--npc-bg);color:inherit;`,
    `border-radius:999px;padding:6px 12px;font:inherit;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.12);}`,

    // The panel itself: an overlay above the interface, closed by Escape.
    `.npc-root{position:fixed;inset:0;z-index:2147483200;display:flex;align-items:center;`,
    `justify-content:center;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.35));}`,
    `.npc-root[hidden]{display:none;}`,
    `.npc-panel{display:flex;flex-direction:column;width:min(920px,92vw);height:min(760px,88vh);`,
    `background:var(--npc-bg);border:1px solid var(--npc-line);border-radius:14px;overflow:hidden;`,
    `box-shadow:0 24px 70px rgba(0,0,0,.35);}`,
    `.npc-head{display:flex;align-items:baseline;gap:12px;padding:16px 18px;border-bottom:1px solid var(--npc-line);}`,
    `.npc-head h2{margin:0;font-size:15px;font-weight:600;}`,
    `.npc-head .npc-project{color:var(--npc-dim);font-size:12px;}`,
    `.npc-head .npc-spacer{flex:1;}`,
    `.npc-body{flex:1;overflow:auto;padding:16px 18px;}`,
    `.npc-foot{padding:10px 18px;border-top:1px solid var(--npc-line);color:var(--npc-dim);font-size:12px;}`,
    `.npc-foot:empty{display:none;}`,

    `.npc-btn{border:1px solid var(--npc-line);background:var(--npc-bg2);color:inherit;border-radius:8px;`,
    `padding:6px 12px;font:inherit;cursor:pointer;}`,
    `.npc-btn:hover{background:var(--npc-hover);}`,
    `.npc-btn[disabled]{opacity:.5;cursor:default;}`,
    // The theme's primary fill is the *inverted* label colour in one theme and
    // the brand colour in the other: measured on the shipped build, the dark
    // theme answers `#f9fafb` here, so white text on it is invisible. The pair
    // the theme itself uses for a filled button is fill + `-foreground`.
    `.npc-btn.npc-primary{background:var(--dsw-alias-button-primary-fill,#2f6feb);`,
    `border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff);}`,
    `.npc-btn.npc-danger{color:#fff;background:var(--npc-danger);border-color:transparent;}`,
    `.npc-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}`,
    `.npc-toolbar{display:flex;gap:8px;align-items:center;margin:12px 0;}`,
    `.npc-toolbar input[type=search],.npc-toolbar select{font:inherit;color:inherit;background:var(--npc-bg2);`,
    `border:1px solid var(--npc-line);border-radius:8px;padding:6px 10px;}`,
    `.npc-toolbar input[type=search]{flex:1;min-width:120px;}`,
    `.npc-stats{display:flex;gap:14px;flex-wrap:wrap;color:var(--npc-dim);font-size:12px;}`,
    `.npc-stats b{color:var(--npc-fg);font-weight:600;}`,

    `.npc-list{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:6px;}`,
    `.npc-list li{margin:0;}`,
    `.npc-item{display:flex;gap:12px;align-items:baseline;width:100%;box-sizing:border-box;text-align:left;`,
    `padding:10px 12px;border:1px solid var(--npc-line);border-radius:10px;background:var(--npc-bg2);`,
    `cursor:pointer;font:inherit;color:inherit;}`,
    `.npc-item:hover{background:var(--npc-hover);}`,
    `.npc-kind{flex:0 0 auto;padding:1px 8px;border-radius:999px;border:1px solid var(--npc-line);font-size:11px;`,
    `text-transform:uppercase;letter-spacing:.04em;color:var(--npc-dim);}`,
    `.npc-meta{flex:0 0 auto;color:var(--npc-dim);font-size:11px;font-variant-numeric:tabular-nums;}`,
    `.npc-preview{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}`,
    `.npc-empty{margin:32px auto;max-width:52ch;text-align:center;color:var(--npc-dim);}`,
    `.npc-empty h3{margin:0 0 6px;font-size:14px;color:var(--npc-fg);}`,
    `.npc-note{margin:10px 0;padding:10px 12px;border-radius:10px;border:1px solid var(--npc-line);`,
    `background:var(--npc-bg2);white-space:pre-wrap;}`,
    `.npc-note.npc-error{border-color:var(--npc-danger);color:var(--npc-danger);}`,
    `.npc-note.npc-warn{border-color:var(--npc-warn);color:var(--npc-warn);}`,
    `.npc-note.npc-ok{border-color:var(--dsw-alias-state-success-primary,#2e7d32);color:var(--dsw-alias-state-success-primary,#2e7d32);}`,
    `.npc-content{margin:12px 0;padding:12px;border:1px solid var(--npc-line);border-radius:10px;background:var(--npc-bg2);`,
    `white-space:pre-wrap;word-break:break-word;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;}`,
    `.npc-kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:10px 0;}`,
    `.npc-kv dt{color:var(--npc-dim);}`,
    `.npc-kv dd{margin:0;word-break:break-word;}`,
    `.npc-danger-zone{margin-top:14px;padding-top:12px;border-top:1px solid var(--npc-line);}`,
    `.npc-back{margin-bottom:10px;}`,
    `.npc-chooser{display:none;}`,
    `.npc-h3{margin:18px 0 6px;font-size:13px;font-weight:600;}`,
  ].join('');
}

/**
 * The whole client side of both sections.
 *
 * Self-contained on purpose: it closes over nothing, so it can be serialised
 * with `toString()` and shipped to the page. The test suite runs this very
 * function against a fake DOM, which is what keeps it honest.
 */
export function clientConsole() {
  var ENDPOINT = '/api/newpi.console';
  var SEATS = SEAT_NAMES;
  var RAIL_WIDTH = RAIL_PIXELS;
  var KINDS = ['note', 'decision', 'bugfix', 'lesson'];
  var PAGE_SIZE = 25;
  var MEMORY_ICON = 'M2 2.5h12v2H2v-2Zm0 4h12v7H2v-7Zm2 2v3h3v-3H4Z';
  var BACKUP_ICON = 'M8 1.5A6.5 6.5 0 1 0 14.5 8h-2A4.5 4.5 0 1 1 8 3.5V6l4-3-4-3v1.5Z';
  /** The panel state, created on first use. */
  var state = null;

  /** One API call. Every failure becomes an Error with a readable message. */
  function call(action, params) {
    return fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: action, params: params || {} }),
    }).then(function (response) {
      return response
        .json()
        .catch(function () {
          return null;
        })
        .then(function (payload) {
          if (response.ok && payload && payload.ok === true) return payload.value;
          var failure = payload && payload.error ? payload.error : null;
          var error = new Error(
            failure && failure.message
              ? failure.message
              : 'Requête refusée (HTTP ' + response.status + ')',
          );
          error.code = failure && failure.code ? failure.code : 'HTTP_' + response.status;
          throw error;
        });
    });
  }

  /** Build one element. Text always goes through `textContent`. */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /** Append the members of a row. */
  function row(className) {
    return el('div', className || 'npc-row');
  }

  /** A definition list row. */
  function kv(list, term, value) {
    list.appendChild(el('dt', null, term));
    list.appendChild(el('dd', null, value));
  }

  /** A button with its handler already attached. */
  function button(className, text, onClick) {
    var node = el('button', className, text);
    node.type = 'button';
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }

  /** Bytes as a short human string. */
  function bytes(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '—';
    if (value < 1024) return String(value) + ' o';
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' Kio';
    return (value / (1024 * 1024)).toFixed(1) + ' Mio';
  }

  /** A timestamp as the user's locale renders it. */
  function when(value) {
    if (!value) return '—';
    var parsed = new Date(value);
    if (isNaN(parsed.getTime())) return String(value);
    return parsed.toLocaleString();
  }

  /** One small glyph per section. */
  function icon(kind) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', kind === 'backup' ? BACKUP_ICON : MEMORY_ICON);
    svg.appendChild(path);
    return svg;
  }

  /** A message block, appended to the given container. */
  function notice(parent, message, kind) {
    parent.appendChild(el('div', 'npc-note' + (kind ? ' npc-' + kind : ''), message));
  }

  /** The one panel state, created the first time a section is opened. */
  function ensurePanel() {
    if (state === null) state = build();
    return state;
  }

  /**
   * The overlay, its panel, and the state both sections render from.
   *
   * Built on first use rather than at injection time: the script is spliced
   * into the document head, where `document.body` is still null, and a section
   * nobody opened has no business building a dialog anyway.
   */
  function build() {
    var root = el('div', 'npc-root');
    root.setAttribute('data-newpi-console', '');
    root.hidden = true;

    var panel = el('section', 'npc-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'NewPi memory and backup');

    var head = el('header', 'npc-head');
    var title = el('h2', null, 'Memory');
    var project = el('span', 'npc-project', '');
    var close = button('npc-btn', 'Fermer', function () {
      root.hidden = true;
    });
    head.appendChild(title);
    head.appendChild(project);
    head.appendChild(el('span', 'npc-spacer'));
    head.appendChild(close);

    var body = el('div', 'npc-body');
    var foot = el('div', 'npc-foot');
    // The archive chooser. A file input is the one file dialog the window
    // itself can put on screen, and the panel it opens belongs to this
    // application rather than to a helper process.
    var chooser = document.createElement('input');
    chooser.type = 'file';
    chooser.accept = '.zip,application/zip';
    chooser.className = 'npc-chooser';
    chooser.setAttribute('data-newpi-console-chooser', '');
    panel.appendChild(head);
    panel.appendChild(body);
    panel.appendChild(foot);
    panel.appendChild(chooser);
    root.appendChild(panel);
    root.addEventListener('click', function (event) {
      if (event.target === root) root.hidden = true;
    });
    document.body.appendChild(root);

    chooser.addEventListener('change', function () {
      var file = chooser.files && chooser.files[0];
      chooser.value = '';
      if (!file) return;
      receiveArchive(ensurePanel(), file);
    });

    return {
      view: 'memory',
      root: root,
      body: body,
      foot: foot,
      title: title,
      project: project,
      chooser: chooser,
      memory: {
        query: '',
        kind: '',
        page: 1,
        items: [],
        total: 0,
        stats: null,
        detail: null,
        loaded: false,
        focusSearch: false,
        // True once the server answered that no project is open. It is a state,
        // not an error: the section says so instead of blaming the backend.
        noProject: false,
      },
      backup: { status: null, inspection: null, report: null, busy: false, activity: '' },
    };
  }

  /** Show a busy line in the panel's footer. */
  function setBusy(state, busy, label) {
    state.foot.textContent = busy ? label || 'Opération en cours…' : '';
  }

  // ---------------------------------------------------------------- memory

  /** Render one memory, content included. */
  function renderDetail(state, detail) {
    var body = state.body;
    body.appendChild(
      button('npc-btn npc-back', '← Retour à la liste', function () {
        state.memory.detail = null;
        renderMemory(state);
      }),
    );

    if (detail.loading) {
      body.appendChild(el('p', 'npc-empty', 'Ouverture du souvenir…'));
      return;
    }
    if (detail.error) {
      notice(body, detail.error, 'error');
      return;
    }

    var head = row();
    head.appendChild(el('span', 'npc-kind', detail.kind));
    head.appendChild(el('span', 'npc-meta', when(detail.created_at)));
    head.appendChild(el('span', 'npc-meta', detail.id));
    body.appendChild(head);
    body.appendChild(el('div', 'npc-content', detail.content));

    var zone = el('div', 'npc-danger-zone');
    zone.appendChild(
      button('npc-btn npc-danger', 'Supprimer ce souvenir', function () {
        confirmDelete(state, detail, zone);
      }),
    );
    body.appendChild(zone);
  }

  /** Ask before deleting, then delete. */
  function confirmDelete(state, detail, zone) {
    zone.textContent = '';
    notice(
      zone,
      'Supprimer définitivement « ' + detail.id + ' » ? Cette action ne peut pas être annulée.',
      'warn',
    );
    var actions = row();
    var yes = button('npc-btn npc-danger', 'Supprimer définitivement', function () {
      yes.disabled = true;
      setBusy(state, true, 'Suppression…');
      call('memory.delete', { id: detail.id, confirm: true })
        .then(function (value) {
          setBusy(state, false);
          state.memory.detail = null;
          state.memory.loaded = false;
          state.memory.page = 1;
          return loadMemory(state).then(function () {
            notice(
              state.body,
              value.deleted ? 'Souvenir supprimé.' : 'Ce souvenir était déjà absent.',
              'ok',
            );
          });
        })
        .catch(function (error) {
          setBusy(state, false);
          yes.disabled = false;
          notice(zone, error.message, 'error');
        });
    });
    actions.appendChild(yes);
    actions.appendChild(
      button('npc-btn', 'Annuler', function () {
        renderMemory(state);
      }),
    );
    zone.appendChild(actions);
  }

  /** Render the Memory section from its current state. */
  function renderMemory(state) {
    var memory = state.memory;
    var body = state.body;
    state.title.textContent = 'Memory · Mémoire du projet';
    body.textContent = '';
    state.foot.textContent = '';

    if (memory.detail !== null) {
      renderDetail(state, memory.detail);
      return;
    }

    // With no project open there is no namespace to read: saying so is the
    // whole answer, and it keeps the personal folder from reading as a project.
    if (memory.noProject) {
      state.project.textContent = 'Aucun projet ouvert';
      var empty = el('div', 'npc-empty');
      empty.appendChild(el('h3', null, 'Aucun projet ouvert'));
      empty.appendChild(
        el(
          'p',
          null,
          'Ouvrez un projet dans la section Projets pour consulter et écrire sa mémoire.',
        ),
      );
      body.appendChild(empty);
      return;
    }

    var stats = row('npc-stats');
    if (memory.stats === null) {
      stats.appendChild(el('span', null, 'Chargement…'));
    } else {
      var total = el('span');
      total.appendChild(el('b', null, String(memory.stats.total)));
      total.appendChild(el('span', null, memory.stats.total === 1 ? ' souvenir' : ' souvenirs'));
      stats.appendChild(total);
      var last = el('span');
      last.appendChild(el('span', null, 'dernière écriture '));
      last.appendChild(el('b', null, when(memory.stats.last_write)));
      stats.appendChild(last);
      stats.appendChild(
        el(
          'span',
          null,
          KINDS.map(function (kind) {
            return kind + ' ' + ((memory.stats.kinds && memory.stats.kinds[kind]) || 0);
          }).join(' · '),
        ),
      );
    }
    body.appendChild(stats);

    var toolbar = row('npc-toolbar');
    var search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Rechercher dans le contenu';
    search.value = memory.query;
    var timer = null;
    search.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        memory.query = search.value;
        memory.page = 1;
        memory.focusSearch = true;
        loadMemory(state);
      }, 220);
    });

    var select = document.createElement('select');
    var all = document.createElement('option');
    all.value = '';
    all.textContent = 'Tous les kinds';
    select.appendChild(all);
    KINDS.forEach(function (kind) {
      var option = document.createElement('option');
      option.value = kind;
      option.textContent = kind;
      select.appendChild(option);
    });
    select.value = memory.kind;
    select.addEventListener('change', function () {
      memory.kind = select.value;
      memory.page = 1;
      loadMemory(state);
    });

    toolbar.appendChild(search);
    toolbar.appendChild(select);
    toolbar.appendChild(
      button('npc-btn', 'Rafraîchir', function () {
        loadMemory(state);
      }),
    );
    body.appendChild(toolbar);

    if (memory.focusSearch) {
      memory.focusSearch = false;
      try {
        search.focus();
        search.setSelectionRange(search.value.length, search.value.length);
      } catch (error) {
        // A browser that refuses to focus a rebuilt field keeps the value.
      }
    }

    if (!memory.loaded) {
      body.appendChild(el('p', 'npc-empty', 'Chargement de la mémoire du projet…'));
      return;
    }

    if (memory.items.length === 0) {
      var empty = el('div', 'npc-empty');
      var filtered = memory.query.length > 0 || memory.kind.length > 0;
      empty.appendChild(
        el('h3', null, filtered ? 'Aucun souvenir ne correspond' : 'Aucun souvenir dans ce projet'),
      );
      empty.appendChild(
        el(
          'p',
          null,
          filtered
            ? 'Élargissez la recherche ou retirez le filtre de kind.'
            : "Ce projet n'a encore rien enregistré. L'agent écrit un souvenir avec l'outil " +
              'remember ; ils apparaîtront ici.',
        ),
      );
      body.appendChild(empty);
      return;
    }

    var list = el('ul', 'npc-list');
    memory.items.forEach(function (item) {
      var entry = el('li');
      entry.appendChild(
        button('npc-item', null, function () {
          memory.detail = { loading: true, id: item.id };
          renderMemory(state);
          call('memory.read', { id: item.id })
            .then(function (value) {
              memory.detail = value.memory;
              renderMemory(state);
            })
            .catch(function (error) {
              memory.detail = { error: error.message, id: item.id };
              renderMemory(state);
            });
        }),
      );
      var cell = entry.firstChild;
      cell.appendChild(el('span', 'npc-kind', item.kind));
      cell.appendChild(el('span', 'npc-meta', when(item.created_at)));
      cell.appendChild(el('span', 'npc-preview', item.preview || '(vide)'));
      list.appendChild(entry);
    });
    body.appendChild(list);

    if (memory.items.length < memory.total) {
      var more = button(
        'npc-btn',
        'Afficher plus (' + (memory.total - memory.items.length) + ')',
        function () {
          memory.page += 1;
          loadMemory(state, true);
        },
      );
      more.style.marginTop = '12px';
      body.appendChild(more);
    }
  }

  /** Load one page of memories, replacing or appending. */
  function loadMemory(state, append) {
    var memory = state.memory;
    setBusy(state, true, 'Lecture de la mémoire…');
    return call('memory.page', {
      query: memory.query,
      kind: memory.kind,
      page: memory.page,
      perPage: PAGE_SIZE,
    })
      .then(function (value) {
        memory.items = append ? memory.items.concat(value.items) : value.items;
        memory.total = value.total;
        memory.loaded = true;
        memory.noProject = value.no_project === true;
        return call('memory.status', {});
      })
      .then(function (stats) {
        memory.stats = stats;
        // The header names the project the way the Project Model names it; the
        // namespace stays out of the interface.
        state.project.textContent = stats.no_project === true
          ? 'Aucun projet ouvert'
          : (stats.project_name || stats.project_id);
        setBusy(state, false);
        renderMemory(state);
      })
      .catch(function (error) {
        setBusy(state, false);
        memory.loaded = true;
        renderMemory(state);
        notice(state.body, error.message, 'error');
      });
  }

  // ---------------------------------------------------------------- backup

  /** The report of the last backup or of the last restore. */
  function renderReport(state, report) {
    if (report.kind === 'create') {
      notice(
        state.body,
        'Sauvegarde créée : ' +
          report.path +
          '\n' +
          bytes(report.bytes) +
          ' · ' +
          report.manifest.memories.total +
          ' souvenir(s) dans la base',
        'ok',
      );
      return;
    }
    var verification = report.verification;
    notice(
      state.body,
      'Restauration terminée depuis ' + report.archive.name + '.\n' +
        'Sauvegarde de sécurité : ' + report.safety.path + '\n' +
        (verification
          ? 'Vérifié : ' +
            verification.total +
            ' souvenir(s) lisibles dans la base, ' +
            verification.project_total +
            ' dans ce projet (' +
            verification.project_id +
            ').'
          : 'La vérification n’a pas pu être lue.'),
      report.rolled_back ? 'error' : 'ok',
    );
  }

  /** The metadata shown before a restore is confirmed. */
  function renderInspection(state, inspection) {
    var body = state.body;
    var manifest = inspection.manifest || {};
    notice(body, 'Archive choisie : ' + inspection.archive.name + ' · ' + bytes(inspection.archive.bytes));

    if (!inspection.ok) {
      notice(body, inspection.message, 'error');
      body.appendChild(
        button('npc-btn', 'Choisir une autre archive', function () {
          state.backup.inspection = null;
          renderBackup(state);
        }),
      );
      return;
    }
    if (inspection.warning) notice(body, inspection.warning, 'warn');

    var list = el('dl', 'npc-kv');
    kv(list, 'Créée le', when(manifest.created_at));
    kv(list, 'NewPi', manifest.created_by ? manifest.created_by.version : '—');
    kv(list, 'PocketBase', manifest.pocketbase ? manifest.pocketbase.version : '—');
    kv(list, 'Format', 'format ' + manifest.format_version + ' (' + manifest.format + ')');
    kv(list, 'Projet d’origine', manifest.source ? manifest.source.project_id : '—');
    kv(list, 'Souvenirs dans l’archive', manifest.memories ? manifest.memories.total : '—');
    kv(
      list,
      'Souvenirs actuels (toute la base)',
      inspection.current ? inspection.current.total : '—',
    );
    kv(
      list,
      'dont ce projet',
      inspection.current ? inspection.current.project_total : '—',
    );
    kv(
      list,
      'Contenu',
      (manifest.contents ? manifest.contents.entries.join(', ') : '—') +
        (manifest.contents ? ' · ' + bytes(manifest.contents.bytes) : ''),
    );
    body.appendChild(list);

    notice(
      body,
      'L’archive choisie est lue sur cette machine et ne passe par aucun réseau.\n' +
        'Restaurer remplace toute la mémoire locale actuelle, pour tous les projets. ' +
        'Une sauvegarde de sécurité de l’état actuel est créée automatiquement avant le remplacement, ' +
        'et les écritures mémoire sont bloquées pendant l’opération.',
      'warn',
    );

    var actions = row();
    var confirm = button(
      'npc-btn npc-danger',
      'Restaurer et remplacer la mémoire locale',
      function () {
        confirm.disabled = true;
        runRestore(state, inspection.archive.path);
      },
    );
    actions.appendChild(confirm);
    actions.appendChild(
      button('npc-btn', 'Annuler', function () {
        state.backup.inspection = null;
        renderBackup(state);
      }),
    );
    body.appendChild(actions);
  }

  /** Render the Backup section from its current state. */
  function renderBackup(state) {
    var backup = state.backup;
    var body = state.body;
    var status = backup.status;
    state.title.textContent = 'Backup · Sauvegarde de la mémoire';
    body.textContent = '';
    state.foot.textContent = '';

    if (status === null) {
      body.appendChild(el('p', 'npc-empty', 'Chargement…'));
      return;
    }
    state.project.textContent = '';

    var versions = row('npc-stats');
    versions.appendChild(el('span', null, 'NewPi ' + status.versions.newpi));
    versions.appendChild(el('span', null, 'PocketBase ' + status.versions.pocketbase));
    versions.appendChild(el('span', null, status.total + ' sauvegarde(s) locale(s)'));
    body.appendChild(versions);

    var actions = row();
    actions.style.margin = '12px 0';
    actions.appendChild(
      button('npc-btn npc-primary', 'Créer une sauvegarde', function () {
        runCreate(state, true);
      }),
    );
    actions.appendChild(
      button('npc-btn', 'Restaurer une sauvegarde', function () {
        runChoose(state);
      }),
    );
    actions.appendChild(
      button('npc-btn', 'Ouvrir le dossier des sauvegardes', function () {
        call('backup.reveal', {})
          .then(function (value) {
            notice(body, 'Dossier ouvert : ' + value.directory, 'ok');
          })
          .catch(function (error) {
            notice(body, error.message, 'error');
          });
      }),
    );
    body.appendChild(actions);

    if (backup.busy) notice(body, backup.activity || 'Opération en cours…', 'warn');
    if (backup.report !== null) renderReport(state, backup.report);
    if (backup.inspection !== null) {
      renderInspection(state, backup.inspection);
      return;
    }

    body.appendChild(el('h3', 'npc-h3', 'Dernières sauvegardes locales'));
    if (status.backups.length === 0) {
      var empty = el('div', 'npc-empty');
      empty.appendChild(el('h3', null, 'Aucune sauvegarde locale'));
      empty.appendChild(
        el(
          'p',
          null,
          '« Créer une sauvegarde » en écrit une ici ; vous pouvez aussi choisir un autre emplacement.',
        ),
      );
      body.appendChild(empty);
    } else {
      var list = el('ul', 'npc-list');
      status.backups.forEach(function (item) {
        var entry = el('li');
        entry.appendChild(
          button('npc-item', null, function () {
            inspect(state, { path: item.path });
          }),
        );
        var cell = entry.firstChild;
        cell.appendChild(el('span', 'npc-kind', item.kind === 'safety' ? 'sécurité' : 'manuelle'));
        cell.appendChild(
          el('span', 'npc-meta', when(item.manifest ? item.manifest.created_at : item.modified)),
        );
        cell.appendChild(el('span', 'npc-preview', item.name));
        cell.appendChild(el('span', 'npc-meta', bytes(item.bytes)));
        list.appendChild(entry);
      });
      body.appendChild(list);
    }
    body.appendChild(el('p', 'npc-project', 'Dossier : ' + status.directory));
  }

  /** A minimal body while a long operation runs. */
  function renderBusy(state) {
    var body = state.body;
    body.textContent = '';
    var box = el('div', 'npc-empty');
    box.appendChild(el('h3', null, 'Opération en cours'));
    box.appendChild(
      el(
        'p',
        null,
        'Ne fermez pas NewPi. La base est remplacée puis vérifiée ; les écritures mémoire sont ' +
          'bloquées jusqu’à la fin.',
      ),
    );
    body.appendChild(box);
  }

  /** Reload the Backup section from the host. */
  function refreshBackup(state) {
    return call('backup.status', {})
      .then(function (value) {
        state.backup.status = value;
        state.backup.busy = value.busy;
        state.backup.activity = value.activity;
        renderBackup(state);
      })
      .catch(function (error) {
        state.backup.status = state.backup.status || {
          versions: { newpi: '?', pocketbase: '?' },
          backups: [],
          total: 0,
          directory: '?',
        };
        renderBackup(state);
        notice(state.body, error.message, 'error');
      });
  }

  /** Create one backup, asking for its destination in the save panel. */
  function runCreate(state, pick) {
    state.backup.report = null;
    state.backup.inspection = null;
    state.backup.busy = true;
    setBusy(state, true, 'Sauvegarde en cours…');
    renderBusy(state);
    call('backup.create', { pick: pick === true })
      .then(function (value) {
        state.backup.busy = false;
        state.backup.report = value.cancelled
          ? null
          : { kind: 'create', path: value.path, bytes: value.bytes, manifest: value.manifest };
        return refreshBackup(state).then(function () {
          if (value.cancelled) notice(state.body, 'Sauvegarde annulée.', 'warn');
        });
      })
      .catch(function (error) {
        state.backup.busy = false;
        return refreshBackup(state).then(function () {
          notice(state.body, error.message, 'error');
        });
      });
  }

  /** Open the window's own archive chooser. */
  function runChoose(state) {
    state.backup.report = null;
    state.backup.inspection = null;
    renderBackup(state);
    state.chooser.click();
  }

  /**
   * Read the chosen archive and ask the host to describe it.
   *
   * The file is read in the page and handed over as bytes, because the panel
   * that chose it belongs to this window: the host never sees a path the user
   * typed, and the archive never leaves the machine.
   */
  function receiveArchive(state, file) {
    setBusy(state, true, 'Lecture de l’archive…');
    var reader = new FileReader();
    reader.onerror = function () {
      setBusy(state, false);
      renderBackup(state);
      notice(state.body, 'Le fichier choisi n’a pas pu être lu.', 'error');
    };
    reader.onload = function () {
      var encoded = String(reader.result);
      var comma = encoded.indexOf(',');
      setBusy(state, true, 'Vérification de l’archive…');
      call('backup.upload', {
        name: file.name,
        bytes: comma >= 0 ? encoded.slice(comma + 1) : encoded,
      })
        .then(function (value) {
          return call('backup.inspect', { path: value.path });
        })
        .then(function (value) {
          setBusy(state, false);
          state.backup.inspection = value;
          renderBackup(state);
        })
        .catch(function (error) {
          setBusy(state, false);
          renderBackup(state);
          notice(state.body, error.message, 'error');
        });
    };
    reader.readAsDataURL(file);
  }

  /** Show one existing archive's metadata. */
  function inspect(state, params) {
    setBusy(state, true, 'Vérification de l’archive…');
    call('backup.inspect', params)
      .then(function (value) {
        setBusy(state, false);
        state.backup.inspection = value;
        renderBackup(state);
      })
      .catch(function (error) {
        setBusy(state, false);
        renderBackup(state);
        notice(state.body, error.message, 'error');
      });
  }

  /** Replace the live database with the chosen archive. */
  function runRestore(state, path) {
    state.backup.inspection = null;
    state.backup.busy = true;
    setBusy(state, true, 'Restauration en cours…');
    renderBusy(state);
    call('backup.restore', { path: path, confirm: true })
      .then(function (value) {
        state.backup.busy = false;
        state.backup.report = value;
        return refreshBackup(state);
      })
      .catch(function (error) {
        state.backup.busy = false;
        return refreshBackup(state).then(function () {
          notice(state.body, error.message, 'error');
        });
      });
  }

  // ----------------------------------------------------------------- shell

  /** Open one section. */
  function openPanel(view) {
    var state = ensurePanel();
    state.view = view;
    state.root.hidden = false;
    if (view === 'memory') {
      state.memory.detail = null;
      state.memory.page = 1;
      renderMemory(state);
      loadMemory(state);
    } else {
      // Opening a section shows the section, not whatever screen a previous
      // visit left behind: an archive that was inspected half an hour ago is
      // not what "Backup" means when it is opened again.
      state.backup.report = null;
      state.backup.inspection = null;
      renderBackup(state);
      refreshBackup(state);
    }
  }

  /** The width of the box a seat sits in, or 0 when nothing is laid out yet. */
  function seatWidth(seat) {
    var node = seat;
    while (node && node.clientWidth === 0 && node.parentElement) node = node.parentElement;
    return node ? node.clientWidth : 0;
  }

  /** Show icons alone while the sidebar is a collapsed rail. */
  function adaptToRail(seat, rows) {
    var width = seatWidth(seat);
    var rail = width > 0 && width < RAIL_WIDTH;
    rows.forEach(function (node) {
      if (rail) node.classList.add('npc-rail');
      else node.classList.remove('npc-rail');
    });
  }

  /** The two sidebar rows, added to the first seat this build renders. */
  function installNav() {
    var seat = null;
    for (var index = 0; index < SEATS.length; index += 1) {
      seat = document.querySelector('[data-slot="' + SEATS[index] + '"]');
      if (seat) break;
    }
    if (!seat) return false;
    if (seat.querySelector('[data-newpi-console-nav]')) return true;

    var rows = [
      { view: 'memory', label: 'Memory' },
      { view: 'backup', label: 'Backup' },
    ].map(function (entry) {
      var node = button('npc-navrow', null, function () {
        openPanel(entry.view);
      });
      node.setAttribute('data-newpi-console-nav', entry.view);
      node.setAttribute('title', entry.label);
      node.appendChild(icon(entry.view));
      node.appendChild(el('span', null, entry.label));
      seat.appendChild(node);
      return node;
    });

    adaptToRail(seat, rows);
    var box = seatWidth(seat) > 0 ? seat : seat.parentElement;
    if (box && typeof ResizeObserver === 'function') {
      try {
        new ResizeObserver(function () {
          adaptToRail(seat, rows);
        }).observe(box);
      } catch (error) {
        // A browser without a usable ResizeObserver keeps the expanded rows.
      }
    }
    return true;
  }

  /** A floating pair of buttons, when the sidebar offers no seat at all. */
  function installFallback() {
    if (document.querySelector('[data-newpi-console-chip]')) return;
    if (!document.body) return;
    var chip = el('div', 'npc-chip');
    chip.setAttribute('data-newpi-console-chip', '');
    [
      { view: 'memory', label: 'Memory' },
      { view: 'backup', label: 'Backup' },
    ].forEach(function (entry) {
      chip.appendChild(
        button(null, entry.label, function () {
          openPanel(entry.view);
        }),
      );
    });
    document.body.appendChild(chip);
  }

  /**
   * Wire everything up, and never let a failure escape into the page.
   *
   * The panel is not built here: only the rows are, and only once the sidebar
   * exists. A section nobody opened costs nothing, and the script cannot fail
   * on a document whose body has not been parsed yet.
   */
  function start() {
    try {
      window.addEventListener('keydown', function (event) {
        var current = state;
        if (current && event.key === 'Escape' && !current.root.hidden) current.root.hidden = true;
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
        // Give up on the observer here regardless of the outcome: it already
        // disconnects itself on success, but a success reached through this
        // direct call — rather than through a mutation it watched — would
        // otherwise leave it running on every mutation for the rest of the
        // session.
        observer.disconnect();
        if (!installNav()) installFallback();
      }, 4000);
    } catch (error) {
      if (window.console && window.console.error) {
        window.console.error('newpi memory console: ' + error);
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
export function consoleScript() {
  // A function serialised with `toString` cannot close over a module constant,
  // so the seat list is substituted into its source before it is shipped.
  const source = clientConsole
    .toString()
    .replace('var SEATS = SEAT_NAMES;', `var SEATS = ${JSON.stringify(NAV_SEATS)};`)
    .replace('var RAIL_WIDTH = RAIL_PIXELS;', `var RAIL_WIDTH = ${Number(RAIL_WIDTH)};`);
  return `(${source})();`;
}

/**
 * Inject both sections into the rendered interface.
 *
 * A pure function of its input, as `tapIndex` requires: no state, no clock, no
 * I/O. A document without a head is still served with both additions, exactly
 * as the branding transform does.
 *
 * @param html - the rendered `index.html` body.
 * @returns the body with the console's style and script added.
 */
export function installConsole(html) {
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  const markup =
    `<style ${CONSOLE_ATTRIBUTE}>${consoleStyle()}</style>` +
    `<script ${CONSOLE_ATTRIBUTE}>${consoleScript()}</script>`;
  if (head === null) return `${markup}${html}`;
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}${markup}${html.slice(at)}`;
}
