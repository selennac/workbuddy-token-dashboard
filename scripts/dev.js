/**
 * 一条命令同时拉起解析服务与前端。
 * 不引入 concurrently 等依赖，纯粹用 child_process。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const root = path.resolve(import.meta.dirname, '..');

function run(name, color, cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd, shell: isWin, env: process.env });
  const tag = `\x1b[${color}m[${name}]\x1b[0m `;

  const pipe = (stream) => {
    stream.setEncoding('utf8');
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) process.stdout.write(tag + l + '\n');
    });
  };

  pipe(child.stdout);
  pipe(child.stderr);

  child.on('exit', (code) => {
    process.stdout.write(tag + `进程退出，code=${code}\n`);
  });
  return child;
}

console.log('启动 WorkBuddy Token 看板…\n');

const server = run('server', '36', process.execPath, ['--watch', 'src/index.js'], path.join(root, 'server'));
const web = run('web   ', '35', npm, ['run', 'dev'], path.join(root, 'web'));

const shutdown = () => {
  server.kill();
  web.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
