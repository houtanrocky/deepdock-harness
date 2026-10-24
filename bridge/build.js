'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function bridgeBuildId(directory = __dirname) {
  const hash = crypto.createHash('sha256');
  function visit(root) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') visit(file);
      else if (entry.isFile() && entry.name.endsWith('.js')) hash.update(path.relative(directory, file).replace(/\\/g, '/') + '\0').update(fs.readFileSync(file));
    }
  }
  visit(directory);
  const config = path.join(directory, 'config.json');
  if (fs.existsSync(config)) hash.update('config.json\0').update(fs.readFileSync(config));
  return hash.digest('hex');
}
module.exports = { bridgeBuildId };
if (require.main === module) process.stdout.write(bridgeBuildId());
