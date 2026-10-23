// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 §35.11 #1 residual] Harness benchmark di PERANGKAT pengguna.
 *
 * Proxy CPU throttling (`bench:pq:throttle`) hanya meniru HP kelas bawah di
 * Chromium desktop. Halaman ini menjalankan harness yang sama
 * (`runPqBenchmark`) di browser HP sungguhan, lalu melaporkan p95 + ukuran
 * output + konteks baterai. Hasil bisa disalin sebagai JSON dan ditempel ke
 * `docs/35` — tidak ada data akun yang dibaca/dikirim.
 *
 * Halaman ini NONAKTIF pada build default. Aktifkan dengan:
 *   dev            : `pnpm --filter nyx-web dev --host`
 *   build produksi : `pnpm --filter nyx-web run build:pq-bench`
 * lalu buka `http://<host>:<port>/bench/pq`.
 *
 * Batasan yang ditampilkan apa adanya:
 * - `navigator.getBattery()` hanya ada di Chromium/Android (dan deprecated).
 *   Level baterai dibulatkan 1%, jadi delta hanya proxy kasar konsumsi energi —
 *   bukan pengukuran mWh. Skor utama tetap waktu p95 per operasi.
 * - Yang diukur primitif ML-DSA-65 + X-Wing di thread utama, bukan RTT jaringan
 *   atau biaya IndexedDB.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  PQ_BENCH_BUDGET,
  formatPqBenchmark,
  runPqBenchmark,
  type PqBenchResult,
  type PqTiming,
} from '@lib/pqBench';

const ENABLED = import.meta.env.DEV || import.meta.env.VITE_PQ_BENCH === '1';

interface BatteryLike {
  level: number;
  charging: boolean;
}

type NavigatorWithBattery = Navigator & {
  getBattery?: () => Promise<BatteryLike>;
  deviceMemory?: number;
};

interface BatterySnapshot {
  level: number;
  charging: boolean;
}

interface DeviceReport {
  capturedAt: string;
  iterations: number;
  durationMs: number;
  device: {
    userAgent: string;
    platform: string;
    hardwareConcurrency: number;
    deviceMemoryGb?: number;
  };
  battery: { start: BatterySnapshot | null; end: BatterySnapshot | null };
  bench: PqBenchResult;
}

async function readBattery(): Promise<BatterySnapshot | null> {
  const nav = navigator as NavigatorWithBattery;
  if (typeof nav.getBattery !== 'function') return null;
  try {
    const battery = await nav.getBattery();
    return { level: battery.level, charging: battery.charging };
  } catch {
    return null;
  }
}

function formatPercent(level: number): string {
  return `${Math.round(level * 100)}%`;
}

const ROWS: Array<{
  label: string;
  pick: (result: PqBenchResult) => PqTiming;
  budgetKey: keyof typeof PQ_BENCH_BUDGET;
}> = [
  { label: 'ML-DSA-65 keygen', pick: (r) => r.mlDsa.keygen, budgetKey: 'mlDsaKeygenP95Ms' },
  { label: 'ML-DSA-65 sign', pick: (r) => r.mlDsa.sign, budgetKey: 'mlDsaSignP95Ms' },
  { label: 'ML-DSA-65 verify', pick: (r) => r.mlDsa.verify, budgetKey: 'mlDsaVerifyP95Ms' },
  { label: 'X-Wing keypair', pick: (r) => r.xwing.keypair, budgetKey: 'xwingKeypairP95Ms' },
  { label: 'X-Wing encaps', pick: (r) => r.xwing.encaps, budgetKey: 'xwingEncapsP95Ms' },
  { label: 'X-Wing decaps', pick: (r) => r.xwing.decaps, budgetKey: 'xwingDecapsP95Ms' },
];

export default function PqDeviceBenchPage() {
  const [iterations, setIterations] = useState(5);
  const [report, setReport] = useState<DeviceReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [batteryNow, setBatteryNow] = useState<BatterySnapshot | null>(null);

  useEffect(() => {
    if (!ENABLED) return;
    void readBattery().then(setBatteryNow);
  }, []);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    setCopied(false);
    const startedAt = Date.now();
    const batteryStart = await readBattery();
    try {
      const bench = await runPqBenchmark({ iterations });
      const batteryEnd = await readBattery();
      setBatteryNow(batteryEnd);
      const nav = navigator as NavigatorWithBattery;
      setReport({
        capturedAt: new Date().toISOString(),
        iterations,
        durationMs: Date.now() - startedAt,
        device: {
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          hardwareConcurrency: navigator.hardwareConcurrency ?? 0,
          deviceMemoryGb: nav.deviceMemory,
        },
        battery: { start: batteryStart, end: batteryEnd },
        bench,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunning(false);
    }
  }, [iterations]);

  if (!ENABLED) {
    return (
      <div className="min-h-dvh w-full flex items-center justify-center bg-bg-main p-6">
        <div className="max-w-md w-full bg-bg-surface rounded-xl border border-text-secondary/10 p-6 space-y-3">
          <h1 className="text-lg font-bold text-text-primary">PQ device bench disabled</h1>
          <p className="text-sm text-text-secondary font-mono">
            This build was compiled without <code>VITE_PQ_BENCH=1</code>. Run the dev server
            (<code>pnpm --filter nyx-web dev --host</code>) or build with
            <code> pnpm --filter nyx-web run build:pq-bench</code>, then open
            <code> /bench/pq</code>.
          </p>
        </div>
      </div>
    );
  }

  const json = report ? JSON.stringify(report, null, 2) : '';

  return (
    <div className="min-h-dvh w-full bg-bg-main p-4 md:p-8">
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="bg-bg-surface rounded-xl border border-text-secondary/10 p-5 space-y-2">
          <h1 className="text-lg font-bold text-text-primary uppercase tracking-wider">
            PQ device benchmark
          </h1>
          <p className="text-sm text-text-secondary leading-relaxed">
            Measures ML-DSA-65 and X-Wing directly in this browser. p95 is the score; sizes are
            checked against the wire format. Keep the screen on and the device unplugged if you
            want battery context.
          </p>
          <p className="text-xs text-text-secondary/80 font-mono">
            Battery: {batteryNow ? `${formatPercent(batteryNow.level)} (${batteryNow.charging ? 'charging' : 'on battery'})` : 'unavailable in this browser'}
          </p>
        </div>

        <div className="bg-bg-surface rounded-xl border border-text-secondary/10 p-5 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="pq-iterations" className="text-sm text-text-secondary font-mono">
              Iterations
            </label>
            <select
              id="pq-iterations"
              value={iterations}
              onChange={(event) => setIterations(Number(event.target.value))}
              disabled={running}
              className="bg-bg-main text-text-primary border border-text-secondary/20 rounded-lg px-3 py-2 text-sm font-mono"
            >
              {[5, 20, 50].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void run()}
              disabled={running}
              className="px-4 py-2 rounded-lg bg-accent text-bg-main text-sm font-bold uppercase tracking-wider disabled:opacity-50"
            >
              {running ? 'Running…' : 'Run benchmark'}
            </button>
            {report && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(json);
                    setCopied(true);
                  } catch {
                    setCopied(false);
                  }
                }}
                className="px-4 py-2 rounded-lg border border-text-secondary/20 text-text-primary text-sm font-mono"
              >
                {copied ? 'Copied' : 'Copy JSON'}
              </button>
            )}
          </div>

          {error && (
            <p className="text-sm text-red-400 font-mono" role="alert">
              {error}
            </p>
          )}

          {report && (
            <div className="space-y-4">
              <table className="w-full text-sm font-mono">
                <thead>
                  <tr className="text-left text-text-secondary">
                    <th className="py-1">Operation</th>
                    <th className="py-1 text-right">mean</th>
                    <th className="py-1 text-right">p50</th>
                    <th className="py-1 text-right">p95</th>
                    <th className="py-1 text-right">budget</th>
                  </tr>
                </thead>
                <tbody>
                  {ROWS.map((row) => {
                    const timing = row.pick(report.bench);
                    const budget = PQ_BENCH_BUDGET[row.budgetKey];
                    const over = timing.p95Ms > budget;
                    return (
                      <tr key={row.label} className="border-t border-text-secondary/10">
                        <td className="py-1 text-text-primary">{row.label}</td>
                        <td className="py-1 text-right text-text-secondary">
                          {timing.meanMs.toFixed(2)} ms
                        </td>
                        <td className="py-1 text-right text-text-secondary">
                          {timing.p50Ms.toFixed(2)} ms
                        </td>
                        <td className={`py-1 text-right ${over ? 'text-red-400' : 'text-green-400'}`}>
                          {timing.p95Ms.toFixed(2)} ms
                        </td>
                        <td className="py-1 text-right text-text-secondary">{budget} ms</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <pre className="text-xs text-text-secondary whitespace-pre-wrap break-words bg-bg-main rounded-lg p-3 border border-text-secondary/10">
                {formatPqBenchmark(report.bench)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
