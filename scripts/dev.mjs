import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const forwarded = [];
let host = '127.0.0.1';
let port = '7100';
let plainHttp = false;

const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--host') {
    const next = args[index + 1];
    if (next && !next.startsWith('-')) {
      host = next;
      index += 1;
    } else {
      host = '0.0.0.0';
    }
  } else if (arg.startsWith('--host=')) {
    host = arg.slice('--host='.length) || '0.0.0.0';
  } else if (arg === '--port' || arg === '-p') {
    port = args[index + 1] || port;
    index += 1;
  } else if (arg.startsWith('--port=')) {
    port = arg.slice('--port='.length);
  } else if (arg === '--no-tls') {
    plainHttp = true;
  } else {
    forwarded.push(arg);
  }
}

if (process.platform !== 'linux') {
  console.error('LinuxPanel preview requires Linux with tmux and PAM. Run npm run dev on the target Linux host.');
  process.exit(1);
}

if (!plainHttp) forwarded.push('--no-tls');
const python = process.env.PYTHON || 'python3';
const child = spawn(python, ['-m', 'linuxpanel', '--bind', host, '--port', String(port), ...forwarded], {
  cwd: root,
  stdio: 'inherit'
});

child.on('error', (error) => {
  console.error(`Could not start Python: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code === null ? (signal ? 1 : 0) : code;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
