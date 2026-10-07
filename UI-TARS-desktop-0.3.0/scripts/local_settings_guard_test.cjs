const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.join(
  __dirname,
  '..',
  'apps',
  'ui-tars',
  'src',
  'renderer',
  'src',
  'components',
  'Settings',
  'local.tsx',
);
const source = fs.readFileSync(sourcePath, 'utf8');

if (!source.includes('Promise.race')) {
  throw new Error('checkVLMSettings must bound the setting IPC call');
}
if (!source.includes('setTimeout')) {
  throw new Error('checkVLMSettings must use a timeout for setting IPC');
}
if (!source.includes('catch')) {
  throw new Error('checkVLMSettings must fail safely when setting IPC fails');
}

console.log('local settings guard check passed');
