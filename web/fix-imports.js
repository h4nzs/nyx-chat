const fs = require('fs');
const path = require('path');

const walk = (dir) => {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    file = dir + '/' + file;
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(file));
    } else {
      if (file.endsWith('.ts') || file.endsWith('.tsx')) {
        results.push(file);
      }
    }
  });
  return results;
};

const files = walk('./src');

files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  let changed = false;

  if (content.includes('socket.io-client')) {
    content = content.replace(/import.*?from ['"]socket\.io-client['"];?/g, '');
    changed = true;
  }

  if (content.includes('lib/socket') || content.includes('@lib/socket')) {
    content = content.replace(/['"]@lib\/socket['"]/g, "'@lib/transportClient'");
    content = content.replace(/['"]\.\/lib\/socket['"]/g, "'./lib/transportClient'");
    content = content.replace(/['"]\.\.\/lib\/socket['"]/g, "'../lib/transportClient'");
    changed = true;
  }

  if (content.includes('getSocket()')) {
    content = content.replace(/getSocket\(\)\?/g, 'transportClient');
    content = content.replace(/getSocket\(\)/g, 'transportClient');
    content = content.replace(/const socket = transportClient;/g, '');
    content = content.replace(/let socket = transportClient;/g, '');
    changed = true;
  }

  if (content.includes('socket.')) {
    content = content.replace(/socket\./g, 'transportClient.');
    changed = true;
  }
  
  if (content.includes('transportClient.transportClient.')) {
    content = content.replace(/transportClient\.transportClient\./g, 'transportClient.');
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(file, content, 'utf8');
  }
});
