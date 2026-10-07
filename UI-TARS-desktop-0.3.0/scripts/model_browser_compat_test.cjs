const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(
  __dirname,
  '..',
  'packages',
  'ui-tars',
  'sdk',
  'src',
  'Model.ts',
);
const source = fs.readFileSync(file, 'utf8');

if (source.includes('Number(process.env.UI_TARS_REQUEST_TIMEOUT_MS')) {
  throw new Error('Model.ts 直接读取 process.env，浏览器渲染器会崩溃');
}
if (!source.includes("typeof process !== 'undefined'")) {
  throw new Error('Model.ts 缺少浏览器安全的 process 存在性检查');
}

console.log('model browser compatibility check passed');
