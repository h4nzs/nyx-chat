import fs from 'fs';

// 1. Baca versi terbaru dari root package.json yang barusan dinaikin
const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
const newVersion = pkg.version;

// 2. SINKRONISASI KE WORKSPACE (Web & Server)
['./web/package.json', './server/package.json'].forEach(path => {
    let subPkg = JSON.parse(fs.readFileSync(path, 'utf8'));
    subPkg.version = newVersion;
    // Tulis ulang dengan format rapi (indentasi 2 spasi)
    fs.writeFileSync(path, JSON.stringify(subPkg, null, 2) + '\n');
});
console.log(`✅ Workspaces (web & server) berhasil disinkronisasi ke versi ${newVersion}!`);

// 3. Format khusus Shields.io untuk README
const badgeVersion = newVersion.replace(/-/g, '--');
const readmePath = './README.md';
let readme = fs.readFileSync(readmePath, 'utf8');

// 4. Update Badge di README
const badgeRegex = /https:\/\/img\.shields\.io\/badge\/version-(.*?)-blue\?style=for-the-badge/g;
readme = readme.replace(badgeRegex, `https://img.shields.io/badge/version-${badgeVersion}-blue?style=for-the-badge`);

fs.writeFileSync(readmePath, readme);
console.log(`✅ Badge README.md berhasil di-update ke versi ${newVersion}!`);
