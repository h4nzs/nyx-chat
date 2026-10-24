/**
 * Readiness probe — apakah dependensi hidup benar-benar menjawab?
 *
 * `/health` (liveness) hanya membuktikan proses Node hidup. Saat Redis atau
 * Postgres mati, Node tetap menjawab 200 sehingga pemantau eksternal mengira
 * semuanya sehat. Probe ini menjalankan pengecekan ringan dengan timeout keras
 * agar endpoint tidak ikut menggantung saat dependensi macet.
 */
export interface ReadinessCheck {
  name: string;
  run: () => Promise<unknown>;
}

export interface ReadinessResult {
  ok: boolean;
  /** Nama check yang gagal/timeout — hanya untuk log server, JANGAN dikirim ke publik. */
  failed: string[];
}

export async function checkReadiness(
  checks: ReadinessCheck[],
  timeoutMs = 2000,
): Promise<ReadinessResult> {
  const failed: string[] = [];
  await Promise.all(
    checks.map(async (check) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          check.run(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
          }),
        ]);
      } catch {
        failed.push(check.name);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );
  return { ok: failed.length === 0, failed: failed.sort() };
}
