import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';

// Interactive container console. The server issues a single-use ticket after a fresh
// authenticator code; this module opens the WebSocket with it and bridges it to xterm.js.
// Messages to the server are JSON ({type:'input'|'resize'}); output arrives as binary frames.
export function createConsoleScreen({ $ }) {
  let terminal = null;
  let socket = null;
  let fit = null;

  function teardown() {
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = null;
      socket.close();
      socket = null;
    }
    if (terminal) { terminal.dispose(); terminal = null; }
    fit = null;
  }

  function status(text) {
    $('#console-status').textContent = text;
  }

  function sendResize() {
    if (!fit || !socket || socket.readyState !== WebSocket.OPEN) return;
    fit.fit();
    socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
  }

  function openConsole({ ticket, title }) {
    teardown();
    $('#console-title').textContent = title;
    status('Connecting…');
    $('#console-dialog').showModal();
    terminal = new Terminal({ cursorBlink: true, convertEol: false, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 13, scrollback: 5000 });
    fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open($('#console-terminal'));
    fit.fit();
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}/api/console?ticket=${encodeURIComponent(ticket)}`);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => { status(''); sendResize(); terminal.focus(); };
    // xterm decodes UTF-8 bytes itself, including sequences split across frames.
    socket.onmessage = event => {
      if (terminal) terminal.write(typeof event.data === 'string' ? event.data : new Uint8Array(event.data));
    };
    socket.onclose = event => {
      const reason = event.reason || (event.code === 1006 ? 'Connection lost or refused' : 'Disconnected');
      status(`Console closed: ${reason}`);
      if (terminal) terminal.write(`\r\n\x1b[2m[${reason}]\x1b[0m\r\n`);
    };
    terminal.onData(data => {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }));
    });
  }

  window.addEventListener('resize', sendResize);
  $('#console-dialog').addEventListener('close', teardown);

  return { openConsole };
}
