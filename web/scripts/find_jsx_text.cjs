const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '../src/pages');

function walk(directory, callback) {
  fs.readdirSync(directory).forEach(file => {
    const fullPath = path.join(directory, file);
    if (fs.statSync(fullPath).isDirectory()) {
      walk(fullPath, callback);
    } else {
      callback(fullPath);
    }
  });
}

walk(dir, (file) => {
  if (file.endsWith('.tsx')) {
    const content = fs.readFileSync(file, 'utf-8');
    // very naive regex to find >Text<
    const matches = [...content.matchAll(/>([^<>{]+)</g)];
    const texts = matches.map(m => m[1].trim()).filter(t => t.length > 2 && /[a-zA-Z]/.test(t) && !t.includes('&quot;'));
    if (texts.length > 0) {
      console.log(`\n--- ${path.basename(file)} ---`);
      texts.forEach(t => console.log(t));
    }
  }
});
