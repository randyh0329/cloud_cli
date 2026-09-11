/* eslint-env browser */
'use strict';

/**
 * Speaks ttyd's WebSocket protocol against an xterm.js terminal.
 *
 * We run our own xterm instance (spec §3.4) rather than iframing ttyd's page,
 * so this reimplements ttyd's client side of the wire format:
 *
 *   GET  <base>/token            -> {"token": "..."}
 *   WS   <base>/ws               subprotocol "tty", binary frames
 *
 *   first client frame           JSON: {AuthToken, columns, rows}
 *                                (ttyd dispatches on the leading '{')
 *   client -> server             1 command byte + payload
 *                                  '0' INPUT     '1' RESIZE {columns,rows}
 *                                  '2' PAUSE     '3' RESUME
 *   server -> client             1 command byte + payload
 *                                  '0' OUTPUT    '1' SET_WINDOW_TITLE
 *                                  '2' SET_PREFERENCES
 */

const CMD = {
  // server -> client
  OUTPUT: '0',
  SET_WINDOW_TITLE: '1',
  SET_PREFERENCES: '2',
  // client -> server
  INPUT: '0',
  RESIZE_TERMINAL: '1',
  PAUSE: '2',
  RESUME: '3',
};

// ttyd pauses the pty when the client falls behind. Mirror its default.
const FLOW_CONTROL_HIGH_WATER = 100 * 1024;

const THEME = {
  background: '#12151b',
  foreground: '#d5dae2',
  cursor: '#7aa2f7',
  cursorAccent: '#12151b',
  selectionBackground: '#2d3f61',
  black: '#20242e',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#414868',
  brightRed: '#ff7a93',
  brightGreen: '#b9f27c',
  brightYellow: '#ff9e64',
  brightBlue: '#7da6ff',
  brightMagenta: '#bb9af7',
  brightCyan: '#0db9d7',
  brightWhite: '#e6ecff',
};

class TtydTerminal {
  /**
   * @param {object} opts
   * @param {string} opts.slug        project slug
   * @param {HTMLElement} opts.mount  container; must be visible before open()
   * @param {(state: string, detail?: string) => void} [opts.onState]
   */
  constructor({ slug, mount, onState }) {
    this.slug = slug;
    this.mount = mount;
    this.onState = onState || (() => {});
    this.base = `/term/${encodeURIComponent(slug)}`;

    this.term = null;
    this.fitAddon = null;
    this.socket = null;
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();

    this.opened = false;
    this.disposed = false;
    this.pendingWrites = 0;
    this.paused = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.resizeObserver = null;
    this.title = slug;
  }

  /** Create the xterm instance. The mount element must have a real size. */
  open() {
    if (this.opened) return;
    this.opened = true;

    this.term = new window.Terminal({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      scrollback: 10000,
      allowProposedApi: true,
      // A TUI like Claude Code turns on mouse reporting, and from then on
      // xterm hands drags to the application instead of selecting text. The
      // escape hatch is Shift+drag — on macOS Option+drag, which only works
      // with this flag on (it defaults to false).
      macOptionClickForcesSelection: true,
      theme: THEME,
    });
    this.fitAddon = new window.FitAddon.FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(this.mount);
    this.#enableCopyOnCtrlC();

    this.term.onData((data) => this.#send(CMD.INPUT + data));
    this.term.onBinary((data) => this.#send(CMD.INPUT + data));
    this.term.onResize(({ cols, rows }) => {
      this.#send(CMD.RESIZE_TERMINAL + JSON.stringify({ columns: cols, rows }));
    });

    // A hidden pane has no size; refit whenever it gains one.
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(this.mount);

    this.fit();
    this.connect();
  }

  /**
   * Make Ctrl+C copy when — and only when — there is a selection.
   *
   * Stock xterm maps Ctrl+C to ETX unconditionally and calls preventDefault, so
   * the browser's copy command never fires and text can't be lifted out of a
   * running program at all. Returning false from the custom handler leaves the
   * event alone; the browser then raises `copy`, which xterm's own listener
   * fills from the selection.
   *
   * With no selection the chord falls through to ETX, so interrupting a TUI is
   * unaffected. The selection is dropped right after a copy so the *next*
   * Ctrl+C interrupts rather than silently re-copying — in a Claude Code
   * session that difference matters more than keeping the highlight.
   */
  #enableCopyOnCtrlC() {
    const isMac = /Mac|iPhone|iPad/i.test(window.navigator.platform || window.navigator.userAgent);
    this.term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown' || ev.key !== 'c' && ev.key !== 'C') return true;
      const chord = isMac ? ev.metaKey && !ev.ctrlKey : ev.ctrlKey && !ev.altKey && !ev.metaKey;
      if (!chord || !this.term.hasSelection()) return true;
      return false;
    });
    // Clearing inside the copy event itself would race xterm's own handler,
    // which reads the selection synchronously to fill the clipboard.
    this.mount.addEventListener('copy', () => {
      setTimeout(() => {
        if (this.term) this.term.clearSelection();
      }, 0);
    });
  }

  fit() {
    if (!this.fitAddon || !this.mount.clientWidth || !this.mount.clientHeight) return;
    try {
      this.fitAddon.fit();
    } catch {
      /* xterm throws if the element is mid-layout; the next observation retries */
    }
  }

  focus() {
    if (this.term) this.term.focus();
  }

  get dimensions() {
    return this.term ? { cols: this.term.cols, rows: this.term.rows } : { cols: 80, rows: 24 };
  }

  async connect() {
    if (this.disposed) return;
    clearTimeout(this.reconnectTimer);
    this.#state('connecting');

    let token = '';
    try {
      const res = await fetch(`${this.base}/token`, { credentials: 'same-origin' });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        token = body.token || '';
      } else if (res.status === 502) {
        // The project exists but ttyd is not running — retrying fast is pointless.
        this.#state('down', `ttyd for "${this.slug}" is not running`);
        this.#scheduleReconnect();
        return;
      }
    } catch {
      // /token is optional in some ttyd builds; carry on with an empty token
      // and let the WebSocket handshake be the real test.
    }
    if (this.disposed) return;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket;
    try {
      socket = new WebSocket(`${proto}//${location.host}${this.base}/ws`, ['tty']);
    } catch (err) {
      this.#state('error', String(err));
      this.#scheduleReconnect();
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.#state('open');
      const { cols, rows } = this.dimensions;
      // ttyd keys on the leading '{' to treat this as the init message.
      socket.send(this.encoder.encode(JSON.stringify({ AuthToken: token, columns: cols, rows })));
      this.term.options.disableStdin = false;
      this.fit();
      this.#send(CMD.RESIZE_TERMINAL + JSON.stringify({ columns: cols, rows }));
    };

    socket.onmessage = (ev) => this.#onFrame(ev.data);

    socket.onclose = (ev) => {
      this.socket = null;
      if (this.disposed) return;
      this.term.options.disableStdin = true;
      this.#state('closed', ev.reason || `code ${ev.code}`);
      this.#scheduleReconnect();
    };

    socket.onerror = () => {
      // 'close' always follows; state is reported there so we don't double-report.
    };
  }

  #onFrame(raw) {
    if (typeof raw === 'string') return; // ttyd only sends binary
    const bytes = new Uint8Array(raw);
    if (bytes.length === 0) return;
    const cmd = String.fromCharCode(bytes[0]);
    const payload = bytes.subarray(1);

    switch (cmd) {
      case CMD.OUTPUT:
        this.#writeWithFlowControl(payload);
        break;
      case CMD.SET_WINDOW_TITLE:
        this.title = this.decoder.decode(payload);
        this.onState('title', this.title);
        break;
      case CMD.SET_PREFERENCES:
        try {
          const prefs = JSON.parse(this.decoder.decode(payload));
          for (const [k, v] of Object.entries(prefs)) this.term.options[k] = v;
        } catch {
          /* a malformed preferences blob must not kill the session */
        }
        break;
      default:
        break;
    }
  }

  /**
   * xterm's write callback fires once the data is parsed. If the pty outruns
   * the renderer, tell ttyd to stop reading rather than growing an unbounded
   * queue in the browser.
   */
  #writeWithFlowControl(payload) {
    this.pendingWrites += payload.length;
    if (!this.paused && this.pendingWrites > FLOW_CONTROL_HIGH_WATER) {
      this.paused = true;
      this.#send(CMD.PAUSE);
    }
    this.term.write(payload, () => {
      this.pendingWrites -= payload.length;
      if (this.paused && this.pendingWrites <= FLOW_CONTROL_HIGH_WATER / 2) {
        this.paused = false;
        this.#send(CMD.RESUME);
      }
    });
  }

  #send(str) {
    const s = this.socket;
    if (!s || s.readyState !== WebSocket.OPEN) return;
    s.send(this.encoder.encode(str));
  }

  #scheduleReconnect() {
    if (this.disposed) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(1000 * 2 ** (this.reconnectAttempt - 1), 15000);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** Manual retry from the UI: reset backoff and go now. */
  retryNow() {
    this.reconnectAttempt = 0;
    clearTimeout(this.reconnectTimer);
    this.connect();
  }

  #state(state, detail) {
    this.state = state;
    this.onState(state, detail);
  }

  /** Only called when a project is deleted — never on tab switch (spec §3.4). */
  dispose() {
    this.disposed = true;
    clearTimeout(this.reconnectTimer);
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
    if (this.term) this.term.dispose();
    this.term = null;
  }
}

window.TtydTerminal = TtydTerminal;
