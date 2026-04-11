const fs = require('fs');
const path = require('path');
const enDir = path.join(__dirname, '../public/locales/en');

const files = ['errors.json', 'common.json', 'settings.json', 'admin.json'];
const dump = {};

files.forEach(file => {
  const p = path.join(enDir, file);
  if (fs.existsSync(p)) {
    dump[file] = JSON.parse(fs.readFileSync(p, 'utf8'));
  }
});

console.log(JSON.stringify(dump, null, 2));
