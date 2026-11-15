// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/41 §6.5] Gate "tes wajib" E2E: suite tidak boleh hijau karena
// tesnya tidak jalan.
//
// Kenapa perlu: dengan reporter dot, `test.skip(...)` yang salah (guard yang
// salah menilai environment, spec yang tidak lagi dikumpulkan, `testIgnore`
// baru) menghasilkan baris hijau yang identik dengan "lulus". Contoh nyata:
// `supportsWebTransport` di `about:blank` melihat `isSecureContext === false`
// sehingga spec WebTransport ter-skip SENYAP di job yang justru dibangun untuk
// menjalankannya (docs/11 §11.5). Exit code Playwright tidak bisa membedakan
// "4 skipped" yang sah dari "21 skipped" yang berarti suite tidak menguji apa
// pun.
//
// Gate ini membaca report JSON Playwright (bukan output teks) dan memeriksa
// tiga hal per project:
//   1. `minTotal`  — jumlah tes yang terkumpul tidak menyusut (spec hilang /
//                    testIgnore / config salah akan mengurangi angka ini).
//   2. `mustPass`  — tes yang wajib ADA dan benar-benar dijalankan; skip pada
//                    tes ini selalu pelanggaran, sekalipun alasannya "masuk akal".
//   3. alasan skip — setiap skip harus punya alasan tertulis yang cocok dengan
//                    daftar `allowedSkipReasons` project itu. Skip tanpa alasan
//                    atau dengan alasan baru = pelanggaran, jadi menambah skip
//                    baru harus lewat manifest (terlihat di review).
//
// Pemakaian:
//   node e2e/verify-required-tests.mjs --project chromium
//   node e2e/verify-required-tests.mjs --project chrome --report playwright-report/results.json
//   node e2e/verify-required-tests.mjs --self-test
//
// Opsi:
//   --project <name>    project Playwright yang diperiksa (wajib kecuali --self-test)
//   --report <path>     report JSON (default: playwright-report/results.json)
//   --manifest <path>   manifest (default: e2e/required-tests.json)
//   --quarantine <path> daftar karantina flake (default: e2e/quarantine.json)
//   --self-test         buktikan gate ini bisa gagal, dengan report sintetis
//
// Keluar 0 bila lolos, 1 bila ada pelanggaran, 2 bila argumen/berkas salah.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`verify-required-tests: --${name} membutuhkan nilai`);
    process.exit(2);
  }
  return value;
}

/**
 * Ratakan pohon suite report Playwright menjadi daftar tes.
 *
 * Bentuk report (diverifikasi terhadap @playwright/test di repo ini):
 * `suites[] -> suites[] -> specs[] -> tests[] -> results[]`; `spec.file` relatif
 * terhadap `testDir`, `test.status` = expected|unexpected|flaky|skipped, alasan
 * skip ada di `test.annotations[]` dengan `type: 'skip'`.
 */
function flattenTests(report) {
  const rows = [];
  const walk = (suite, ancestors, depth) => {
    // Suite kedalaman 0 selalu mewakili satu berkas (judulnya nama berkas) dan
    // TIDAK ikut jadi bagian judul tes. Kedalaman harus dilacak terpisah dari
    // `ancestors`: setelah suite berkas, `ancestors` masih kosong, sehingga
    // memakai panjangnya membuat suite `describe` ikut dibuang dan setiap tes
    // wajib terlihat "hilang" (gate merah palsu — terukur 2026-11-06).
    const isFileSuite = depth === 0;
    const titles = isFileSuite ? ancestors : [...ancestors, suite.title];
    for (const spec of suite.specs ?? []) {
      const file = path.basename(spec.file ?? suite.file ?? '');
      const title = [...titles, spec.title].filter(Boolean).join(' › ');
      for (const test of spec.tests ?? []) {
        const skip = (test.annotations ?? []).find((a) => a.type === 'skip');
        rows.push({
          file,
          title,
          projectName: test.projectName,
          status: test.status,
          skipReason: skip?.description ?? null,
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, titles, depth + 1);
  };
  for (const suite of report.suites ?? []) walk(suite, [], 0);
  return rows;
}

function reasonAllowed(reason, patterns) {
  if (!reason) return false;
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, 'i').test(reason);
    } catch {
      return reason.toLowerCase().includes(String(pattern).toLowerCase());
    }
  });
}

/** Fungsi murni: (report, manifest, project) → daftar pelanggaran. */
export function evaluate(report, manifest, project) {
  const config = manifest.projects?.[project];
  if (!config) return [`manifest tidak punya project "${project}"`];

  const all = flattenTests(report);
  const tests = all.filter((t) => t.projectName === project);
  const violations = [];

  // 1. Jumlah tes tidak boleh menyusut.
  if (tests.length < (config.minTotal ?? 0)) {
    violations.push(
      `hanya ${tests.length} tes terkumpul untuk project "${project}", manifest menuntut minimal ${config.minTotal} ` +
        '(spec hilang, testIgnore baru, atau config mempersempit suite?)'
    );
  }

  // 2. Tes wajib harus ada dan dijalankan.
  for (const required of config.mustPass ?? []) {
    const match = tests.find((t) => t.file === required.file && t.title === required.title);
    if (!match) {
      violations.push(`tes wajib hilang dari suite: ${required.file} › ${required.title}`);
    } else if (match.status === 'skipped') {
      violations.push(
        `tes wajib di-skip: ${required.file} › ${required.title} ` +
          `(alasan: ${match.skipReason ?? 'tanpa alasan'})`
      );
    } else if (match.status === 'unexpected' || match.status === 'flaky') {
      violations.push(`tes wajib ${match.status}: ${required.file} › ${required.title}`);
    }
  }

  // 3. Setiap skip harus beralasan DAN alasannya sudah diizinkan manifest.
  const allowedReasons = config.allowedSkipReasons ?? [];
  for (const test of tests) {
    if (test.status !== 'skipped') continue;
    if (!test.skipReason) {
      violations.push(`skip tanpa alasan tertulis: ${test.file} › ${test.title}`);
      continue;
    }
    if (!reasonAllowed(test.skipReason, allowedReasons)) {
      violations.push(
        `skip dengan alasan yang belum diizinkan manifest: ${test.file} › ${test.title} ` +
          `(alasan: "${test.skipReason}")`
      );
    }
  }

  return violations;
}

/**
 * [docs/41 §7.4] Karantina flake.
 *
 * Sebuah tes boleh berhenti menahan merge untuk sementara, tetapi hanya dengan
 * kontrak yang bisa kedaluwarsa: owner, alasan, dan tanggal. Entri yang lewat
 * tanggal, menunjuk tes yang sudah tidak ada, atau menunjuk tes yang ternyata
 * masih dijalankan adalah pelanggaran — karantina yang tidak pernah dibersihkan
 * lebih buruk daripada tidak ada karantina, karena tesnya berhenti memberi
 * sinyal tanpa ada yang menyadarinya.
 *
 * Tes karantina harus di-skip di spec dengan alasan yang memuat kata
 * "karantina" (mis. `test.skip('karantina: @han — flaky saat rotasi', ...)`).
 * Dengan begitu report tetap menunjukkan tes itu ada, tetapi gate tahu ia tidak
 * dijalankan dan mengapa.
 */
export function evaluateQuarantine(report, quarantine, today = new Date()) {
  const violations = [];
  const tests = flattenTests(report);
  for (const entry of quarantine.entries ?? []) {
    const label = `${entry.file ?? '?'} › ${entry.title ?? '?'}`;
    for (const field of ['file', 'title', 'owner', 'reason', 'expires']) {
      if (!entry[field] || typeof entry[field] !== 'string') {
        violations.push(`karantina tanpa "${field}": ${label}`);
      }
    }
    const expires = Date.parse(entry.expires ?? '');
    if (Number.isNaN(expires)) {
      violations.push(`karantina dengan tanggal kedaluwarsa tidak valid: ${label} (${entry.expires})`);
    } else if (expires < today.getTime()) {
      violations.push(`karantina kedaluwarsa: ${label} (${entry.expires}) — perbaiki tesnya atau hapus entrinya`);
    }
    const test = tests.find((t) => t.file === entry.file && t.title === entry.title);
    if (!test) {
      violations.push(`karantina menunjuk tes yang tidak ada di report: ${label}`);
    } else if (test.status !== 'skipped') {
      violations.push(`tes karantina masih dijalankan (${test.status}): ${label} — tandai skip dengan alasan "karantina: <owner>"`);
    } else if (!(test.skipReason ?? '').toLowerCase().includes('karantina')) {
      violations.push(`tes karantina di-skip tanpa alasan "karantina: …": ${label}`);
    }
  }
  return violations;
}

function summarize(report, project) {
  const tests = flattenTests(report).filter((t) => t.projectName === project);
  const skipped = tests.filter((t) => t.status === 'skipped');
  console.log(
    `verify-required-tests: project "${project}" — ${tests.length} tes, ` +
      `${tests.filter((t) => t.status === 'expected').length} dijalankan, ${skipped.length} skip`
  );
  for (const test of skipped) {
    console.log(`  ⏭️  ${test.file} › ${test.title} — ${test.skipReason ?? 'TANPA ALASAN'}`);
  }
}

// ---------------------------------------------------------------------------
// --self-test: report sintetis, satu skenario per perilaku gate. Tanpa ini,
// "gate hijau" tidak membedakan gate yang bekerja dari gate yang tidak pernah
// memeriksa apa pun.
// ---------------------------------------------------------------------------
function selfTest() {
  const manifest = {
    projects: {
      demo: {
        minTotal: 2,
        mustPass: [{ file: 'wajib.spec.ts', title: 'Grup › wajib jalan' }],
        allowedSkipReasons: ['WebTransport tidak tersedia'],
      },
    },
  };

  const makeReport = (tests) => ({
    suites: [
      {
        title: 'suite.spec.ts',
        file: 'suite.spec.ts',
        specs: tests.map((t) => ({
          title: t.title,
          file: t.file ?? 'suite.spec.ts',
          tests: [
            {
              projectName: 'demo',
              status: t.status ?? 'expected',
              annotations: t.reason ? [{ type: 'skip', description: t.reason }] : [],
            },
          ],
        })),
      },
    ],
  });

  const cases = [
    {
      name: 'semua dijalankan',
      report: makeReport([
        { file: 'wajib.spec.ts', title: 'Grup › wajib jalan' },
        { title: 'lain' },
      ]),
      expectFail: false,
    },
    {
      name: 'skip dengan alasan yang diizinkan',
      report: makeReport([
        { file: 'wajib.spec.ts', title: 'Grup › wajib jalan' },
        { title: 'lain', status: 'skipped', reason: 'WebTransport tidak tersedia di environment ini' },
      ]),
      expectFail: false,
    },
    {
      name: 'tes wajib di-skip',
      report: makeReport([
        { file: 'wajib.spec.ts', title: 'Grup › wajib jalan', status: 'skipped', reason: 'WebTransport tidak tersedia' },
        { title: 'lain' },
      ]),
      expectFail: true,
    },
    {
      name: 'skip tanpa alasan',
      report: makeReport([
        { file: 'wajib.spec.ts', title: 'Grup › wajib jalan' },
        { title: 'lain', status: 'skipped' },
      ]),
      expectFail: true,
    },
    {
      name: 'skip dengan alasan baru yang belum diizinkan',
      report: makeReport([
        { file: 'wajib.spec.ts', title: 'Grup › wajib jalan' },
        { title: 'lain', status: 'skipped', reason: 'lingkungan sedang sibuk' },
      ]),
      expectFail: true,
    },
    {
      name: 'tes wajib hilang',
      report: makeReport([{ file: 'wajib.spec.ts', title: 'Grup › nama berubah' }]),
      expectFail: true,
    },
    {
      name: 'jumlah tes menyusut',
      report: makeReport([{ file: 'wajib.spec.ts', title: 'Grup › wajib jalan' }]),
      expectFail: true,
    },
    {
      // Bentuk report Playwright yang sebenarnya: suite berkas → suite
      // `describe` → spec. Judul `describe` HARUS ikut, kalau tidak setiap
      // mustPass dilaporkan "hilang" padahal lulus (bug 2026-11-06).
      name: 'judul describe dari report asli ikut dihitung',
      report: {
        suites: [
          {
            title: 'wajib.spec.ts',
            file: 'wajib.spec.ts',
            specs: [],
            suites: [
              {
                title: 'Grup',
                file: 'wajib.spec.ts',
                specs: ['wajib jalan', 'lain'].map((title) => ({
                  title,
                  file: 'wajib.spec.ts',
                  tests: [{ projectName: 'demo', status: 'expected', annotations: [] }],
                })),
              },
            ],
          },
        ],
      },
      expectFail: false,
    },
  ];

  let failed = 0;
  for (const testCase of cases) {
    const violations = evaluate(testCase.report, manifest, 'demo');
    const got = violations.length > 0;
    const ok = got === testCase.expectFail;
    if (!ok) failed += 1;
    console.log(`${ok ? '✓' : '✗'} self-test: ${testCase.name} → ${got ? 'menolak' : 'lolos'}`);
    if (!ok) console.log(`   pelanggaran: ${JSON.stringify(violations)}`);
  }
  // [docs/41 §7.4] Karantina: buktikan keempat arahnya (valid, kedaluwarsa,
  // tes hilang, tes masih jalan). Tanpa ini, gate karantina hanya dokumen.
  const today = new Date('2026-11-05T00:00:00Z');
  const quarantineBase = {
    file: 'wajib.spec.ts',
    title: 'Grup › wajib jalan',
    owner: '@han',
    reason: 'flaky saat rotasi',
    expires: '2026-11-30',
  };
  const quarantineCases = [
    {
      name: 'karantina valid (skip beralasan, belum kedaluwarsa)',
      entries: [quarantineBase],
      report: makeReport([
        {
          file: 'wajib.spec.ts',
          title: 'Grup › wajib jalan',
          status: 'skipped',
          reason: 'karantina: @han — flaky saat rotasi',
        },
        { title: 'lain' },
      ]),
      expectFail: false,
    },
    {
      name: 'karantina kedaluwarsa',
      entries: [{ ...quarantineBase, expires: '2026-11-04' }],
      report: makeReport([
        {
          file: 'wajib.spec.ts',
          title: 'Grup › wajib jalan',
          status: 'skipped',
          reason: 'karantina: @han — flaky saat rotasi',
        },
        { title: 'lain' },
      ]),
      expectFail: true,
    },
    {
      name: 'karantina menunjuk tes yang tidak ada',
      entries: [{ ...quarantineBase, title: 'Grup › sudah dihapus' }],
      report: makeReport([{ title: 'lain' }, { title: 'lain 2' }]),
      expectFail: true,
    },
    {
      name: 'tes karantina masih dijalankan',
      entries: [quarantineBase],
      report: makeReport([
        { file: 'wajib.spec.ts', title: 'Grup › wajib jalan' },
        { title: 'lain' },
      ]),
      expectFail: true,
    },
  ];

  for (const testCase of quarantineCases) {
    const violations = evaluateQuarantine(testCase.report, { entries: testCase.entries }, today);
    const got = violations.length > 0;
    const ok = got === testCase.expectFail;
    if (!ok) failed += 1;
    console.log(`${ok ? '✓' : '✗'} self-test karantina: ${testCase.name} → ${got ? 'menolak' : 'lolos'}`);
    if (!ok) console.log(`   pelanggaran: ${JSON.stringify(violations)}`);
  }

  if (failed > 0) {
    console.error(`✗ self-test gate gagal: ${failed}/${cases.length + quarantineCases.length} skenario tidak sesuai harapan`);
    process.exit(1);
  }
  console.log(`✓ self-test gate: ${cases.length + quarantineCases.length}/${cases.length + quarantineCases.length} skenario sesuai harapan`);
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  const project = arg('project', null);
  if (!project) {
    console.error('verify-required-tests: --project wajib (mis. --project chromium) atau pakai --self-test');
    process.exit(2);
  }
  const reportPath = path.resolve(arg('report', 'playwright-report/results.json'));
  const manifestPath = path.resolve(arg('manifest', 'e2e/required-tests.json'));

  let report;
  let manifest;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (error) {
    console.error(`verify-required-tests: gagal membaca report ${reportPath} — ${error.message}`);
    process.exit(2);
  }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    console.error(`verify-required-tests: gagal membaca manifest ${manifestPath} — ${error.message}`);
    process.exit(2);
  }

  summarize(report, project);
  let violations = evaluate(report, manifest, project);

  // [docs/41 §7.4] Karantina dijalankan pada report yang sama: entri yang
  // kedaluwarsa/menunjuk tes hilang/masih dijalankan menggagalkan job.
  const quarantinePath = path.resolve(arg('quarantine', 'e2e/quarantine.json'));
  let quarantine = { entries: [] };
  try {
    quarantine = JSON.parse(readFileSync(quarantinePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`verify-required-tests: gagal membaca karantina ${quarantinePath} — ${error.message}`);
      process.exit(2);
    }
  }
  violations = violations.concat(evaluateQuarantine(report, quarantine));
  if (violations.length > 0) {
    for (const violation of violations) console.error(`✗ ${violation}`);
    console.error(
      `✗ gate tes wajib E2E (${project}): ${violations.length} pelanggaran — ` +
        'suite hijau tidak boleh berarti "tesnya tidak jalan". Perbaiki penyebabnya atau, kalau skip-nya sah, ' +
        'tambahkan alasannya ke e2e/required-tests.json di PR yang sama.'
    );
    process.exit(1);
  }
  console.log(`✓ gate tes wajib E2E (${project}): semua tes wajib dijalankan, semua skip beralasan dan diizinkan`);
}
