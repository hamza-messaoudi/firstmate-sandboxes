// Disposable terminal client for Session.openInteractive, matching Sandbox CLI
// start/resize/binary-input protocol. Node's built-in WebSocket needs no PTY dependency.
// Disconnect only closes this socket; no provider lifecycle or timeout extension.
export async function interactive(connection, record, {
  Socket = WebSocket, input = process.stdin, output = process.stdout, signals = process,
  connectMs = 20000,
} = {}) {
  const url = new URL(connection.url);
  if (url.protocol !== 'wss:') throw Error('interactive transport requires TLS');
  url.searchParams.set('token', connection.token);
  const socket = new Socket(url);
  socket.binaryType = 'arraybuffer';
  let timer;
  const raw = input.isRaw;
  const send = data => { if (socket.readyState === 1) socket.send(data); };
  const resize = () => send(JSON.stringify({ type: 'resize', cols: output.columns || 80, rows: output.rows || 24 }));
  const close = () => socket.close();
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => { close(); reject(Error('viewer connection timed out')); }, connectMs);
      socket.addEventListener('error', () => reject(Error('viewer connection failed')));
      socket.addEventListener('close', resolve, { once: true });
      socket.addEventListener('message', event => {
        if (typeof event.data !== 'string') output.write(Buffer.from(event.data));
        else {
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'exit') {
              if (message.code !== undefined && message.code !== 0) reject(Error('remote tmux attachment failed'));
              close();
            }
          } catch { output.write(event.data); }
        }
      });
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        send(JSON.stringify({ type: 'start', command: 'tmux', args: ['attach-session', '-t', '=' + record.tmux_session],
          cwd: record.remote_repo, env: ['TERM=xterm-256color'], cols: output.columns || 80, rows: output.rows || 24 }));
        input.setRawMode(true);
        input.on('data', send);
        input.on('end', close);
        input.resume();
        signals.on('SIGWINCH', resize);
        signals.on('SIGTERM', close);
        signals.on('SIGINT', close);
      }, { once: true });
    });
  } finally {
    clearTimeout(timer);
    input.removeListener('data', send);
    input.removeListener('end', close);
    signals.removeListener('SIGWINCH', resize);
    signals.removeListener('SIGTERM', close);
    signals.removeListener('SIGINT', close);
    input.setRawMode(Boolean(raw));
    input.pause();
    close();
  }
}
