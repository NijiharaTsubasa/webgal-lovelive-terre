const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'tests'))
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => path.join(root, 'tests', name));

if (!files.length) {
  console.error('No editor regression tests found.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) console.error(result.error);
process.exit(result.status ?? 1);
