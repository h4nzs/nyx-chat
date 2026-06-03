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

const files = walk('web/src');

files.forEach(file => {
  if (file.includes('webrtc.ts') || file.includes('transportClient.ts') || file.includes('transport.worker.ts')) return;

  let content = fs.readFileSync(file, 'utf8');
  let changed = false;

  if (content.includes('transportClient,()')) {
    content = content.replace(/transportClient,\(\)/g, 'transportClient');
    changed = true;
  }
  
  if (content.includes('transportClient()')) {
    content = content.replace(/transportClient\(\)/g, 'transportClient');
    changed = true;
  }

  if (content.includes('transportClient.emit(')) {
    // Replace transportClient.emit('event', payload) with transportClient.sendEvent('event', payload)
    content = content.replace(/transportClient\.emit\(/g, 'transportClient.sendEvent(');
    changed = true;
  }

  // Also replace socket.emit if some were missed
  if (content.includes('socket.emit(')) {
    content = content.replace(/socket\.emit\(/g, 'transportClient.sendEvent(');
    changed = true;
  }
  
  // also socket?.emit
  if (content.includes('socket?.emit(')) {
    content = content.replace(/socket\?\.emit\(/g, 'transportClient.sendEvent(');
    changed = true;
  }
  
  // transportClient?.emit
  if (content.includes('transportClient?.emit(')) {
    content = content.replace(/transportClient\?\.emit\(/g, 'transportClient.sendEvent(');
    changed = true;
  }

  // transportClient.connected => we don't need to change if it's already connected

  if (changed) {
    fs.writeFileSync(file, content, 'utf8');
  }
});
