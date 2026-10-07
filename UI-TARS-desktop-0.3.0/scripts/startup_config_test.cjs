const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(repo, '启动UI-TARS.ps1'), 'utf8');
const main = fs.readFileSync(
  path.join(repo, 'apps', 'ui-tars', 'src', 'main', 'main.ts'),
  'utf8',
);

if (!script.includes('UI_TARS_USER_DATA_DIR')) {
  throw new Error('启动脚本没有设置可写的 UI_TARS_USER_DATA_DIR');
}
if (!main.includes("app.setPath('userData'")) {
  throw new Error('主进程没有应用自定义用户数据目录');
}
if (!main.includes("app.commandLine.appendSwitch('in-process-gpu')")) {
  throw new Error('主进程没有启用进程内 GPU 启动模式');
}

console.log('startup configuration checks passed');
