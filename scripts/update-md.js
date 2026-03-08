import fs from 'fs';

// 1. Baca versi dari package.json
const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
const newVersion = pkg.version;

// 2. Format khusus Shields.io: ubah "-" jadi "--" (misal: 2.3.0-alpha -> 2.3.0--alpha)
const badgeVersion = newVersion.replace(/-/g, '--');

// 3. Target file Markdown
const readmePath = './README.md';
let readme = fs.readFileSync(readmePath, 'utf8');

// 4. Regex khusus buat nangkep URL badge versi lu
// Dia bakal nyari teks di antara "version-" dan "-blue"
const badgeRegex = /https:\/\/img\.shields\.io\/badge\/version-(.*?)-blue\?style=for-the-badge/g;

readme = readme.replace(badgeRegex, `https://img.shields.io/badge/version-${badgeVersion}-blue?style=for-the-badge`);

// 5. Tulis ulang file-nya
fs.writeFileSync(readmePath, readme);
console.log(`✅ Badge README.md berhasil di-update ke versi ${newVersion}!`);
