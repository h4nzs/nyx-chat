// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

//! [audit pass 4, ditutup 2026-11-03] Registry sesi WebTransport dengan
//! penggantian **atomik per user**.
//!
//! Kebijakan single-active-device sebelumnya dijalankan di `main.rs` sebagai
//! tiga langkah terpisah: `sessions.iter()` mencari sesi user, `remove` untuk
//! masing-masing, lalu `insert` sesi baru. Dua AUTH yang selesai bersamaan
//! untuk user yang sama bisa sama-sama **tidak melihat** sesi lawan (belum
//! di-insert) sehingga keduanya lolos dan user punya dua perangkat aktif —
//! persis yang ingin dicegah `redisBridge.isActiveDeviceAllowed` di sisi Node.
//!
//! Di sini find+remove+insert berada dalam satu blok kritis di bawah lock per
//! user, jadi urutan AUTH selalu serial dan sesi terakhir yang mendaftar
//! adalah satu-satunya yang hidup. Lock-nya di-shard (bukan satu mutex global,
//! bukan satu mutex per user yang tak pernah dibebaskan) supaya memori tetap
//! terbatas dan AUTH user berbeda tidak saling menunggu.
//!
//! Modul ini sengaja tanpa WebTransport/Redis supaya perilaku balapan bisa
//! diuji dengan `cargo test` (lihat `mod tests`), termasuk uji konkuren.

use dashmap::DashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;

/// Jumlah shard lock. Kontensi hanya terjadi saat AUTH (jarang), jadi 64
/// sudah cukup untuk menghindari antrean tanpa membuat tabel lock tumbuh.
const LOCK_SHARDS: usize = 64;

/// Peta sesi `user:device:uuid` → koneksi, plus lock per shard user.
pub struct SessionTable<V> {
    sessions: DashMap<String, V>,
    locks: Vec<Mutex<()>>,
}

impl<V> SessionTable<V> {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
            locks: (0..LOCK_SHARDS).map(|_| Mutex::new(())).collect(),
        }
    }

    fn lock_for(&self, user_id: &str) -> &Mutex<()> {
        let mut hasher = DefaultHasher::new();
        user_id.hash(&mut hasher);
        let shard = (hasher.finish() as usize) % LOCK_SHARDS;
        &self.locks[shard]
    }

    /// Jumlah sesi hidup (dipakai gauge `nyx_transport_active_sessions`).
    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }
}

impl<V> Default for SessionTable<V> {
    fn default() -> Self {
        Self::new()
    }
}

impl<V: Clone> SessionTable<V> {
    /// Daftarkan `new_key` sebagai satu-satunya sesi milik `user_id` dan
    /// kembalikan sesi lama yang harus diputus.
    ///
    /// Pemanggil menutup koneksi yang dikembalikan **setelah** fungsi ini
    /// selesai (lock sudah dilepas), karena `close()` bisa memicu I/O.
    pub fn replace_user(&self, user_id: &str, new_key: String, new_value: V) -> Vec<(String, V)> {
        let prefix = format!("{user_id}:");
        // Lock shard user menahan seluruh find+remove+insert. Poison tidak
        // boleh mematikan jalur AUTH: isi lock tidak menyimpan data, jadi
        // `into_inner()` aman.
        let guard = self
            .lock_for(user_id)
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let stale: Vec<String> = self
            .sessions
            .iter()
            .filter(|entry| entry.key().starts_with(&prefix))
            .map(|entry| entry.key().clone())
            .collect();

        let mut kicked = Vec::with_capacity(stale.len());
        for key in stale {
            if let Some((key, value)) = self.sessions.remove(&key) {
                kicked.push((key, value));
            }
        }

        self.sessions.insert(new_key, new_value);
        drop(guard);
        kicked
    }

    /// Hapus satu sesi (dipanggil saat koneksi tertutup). `None` berarti sesi
    /// sudah diputus lebih dulu oleh AUTH perangkat lain.
    pub fn remove(&self, key: &str) -> Option<V> {
        self.sessions.remove(key).map(|(_, value)| value)
    }

    /// Salinan semua sesi yang key-nya berawalan `prefix`
    /// (`user:` untuk broadcast, `user:device:` untuk satu perangkat).
    ///
    /// Sengaja mengembalikan `Vec` (bukan iterator guard) supaya pemanggil
    /// tidak memegang kunci shard DashMap saat mengirim frame.
    pub fn matching_prefix(&self, prefix: &str) -> Vec<(String, V)> {
        self.sessions
            .iter()
            .filter(|entry| entry.key().starts_with(prefix))
            .map(|entry| (entry.key().clone(), entry.value().clone()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use std::thread;

    #[test]
    fn replace_user_kicks_previous_session_and_keeps_one() {
        let table: SessionTable<&str> = SessionTable::new();

        assert!(table
            .replace_user("u1", "u1:a:1".into(), "conn-a")
            .is_empty());
        let kicked = table.replace_user("u1", "u1:b:2".into(), "conn-b");

        assert_eq!(kicked, vec![("u1:a:1".to_string(), "conn-a")]);
        assert_eq!(table.len(), 1);
        assert!(table.remove("u1:a:1").is_none(), "sesi lama sudah diputus");
        assert_eq!(table.remove("u1:b:2"), Some("conn-b"));
        assert!(table.is_empty());
    }

    #[test]
    fn replace_user_does_not_touch_other_users() {
        let table: SessionTable<&str> = SessionTable::new();
        table.replace_user("u1", "u1:a:1".into(), "conn-a1");
        table.replace_user("u2", "u2:a:1".into(), "conn-b1");

        let kicked = table.replace_user("u1", "u1:a:2".into(), "conn-a2");

        assert_eq!(kicked, vec![("u1:a:1".to_string(), "conn-a1")]);
        assert_eq!(table.len(), 2);
        assert_eq!(table.matching_prefix("u2:").len(), 1);
    }

    #[test]
    fn matching_prefix_distinguishes_device_from_user() {
        let table: SessionTable<u8> = SessionTable::new();
        table.replace_user("u1", "u1:d1:1".into(), 1);
        table.replace_user("u10", "u10:d1:1".into(), 2);

        assert_eq!(table.matching_prefix("u1:").len(), 1);
        assert_eq!(table.matching_prefix("u1:d1:").len(), 1);
        assert_eq!(table.matching_prefix("u1:d2:").len(), 0);
        assert_eq!(
            table.matching_prefix("u1").len(),
            2,
            "prefix tanpa ':' jujur"
        );
    }

    /// [audit pass 4] Uji konkuren: 16 AUTH bersamaan untuk user yang sama,
    /// diulang 50 putaran. Tanpa lock per user, putaran tertentu akan
    /// menyisakan >1 sesi atau memutus sesi yang sama dua kali (jumlah kick
    /// < 15) karena find+remove+insert saling mendahului.
    #[test]
    fn concurrent_auth_leaves_exactly_one_session_per_user() {
        const THREADS: usize = 16;
        const ROUNDS: usize = 50;

        for round in 0..ROUNDS {
            let table: Arc<SessionTable<usize>> = Arc::new(SessionTable::new());
            let barrier = Arc::new(Barrier::new(THREADS));
            let mut handles = Vec::with_capacity(THREADS);

            for device in 0..THREADS {
                let table = table.clone();
                let barrier = barrier.clone();
                handles.push(thread::spawn(move || {
                    barrier.wait();
                    table
                        .replace_user("u1", format!("u1:d{device}:{round}"), device)
                        .len()
                }));
            }

            let kicked: usize = handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .sum();

            assert_eq!(
                table.len(),
                1,
                "putaran {round}: harus tepat satu sesi tersisa"
            );
            assert_eq!(
                kicked,
                THREADS - 1,
                "putaran {round}: setiap AUTH setelah yang pertama harus memutus tepat satu sesi"
            );
        }
    }
}
