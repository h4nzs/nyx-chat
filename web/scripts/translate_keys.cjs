const fs = require('fs');
const path = require('path');

const localesPath = path.join(__dirname, '../public/locales');

const dict = {
  id: {
    errors: {
      "failed_to_load_linked_devices": "Gagal memuat perangkat tertaut",
      "failed_to_revoke_device": "Gagal mencabut perangkat",
      "please_start_a_chat_with_yourself_saved_": "Silakan mulai obrolan dengan diri Anda sendiri ('Pesan Tersimpan') terlebih dahulu untuk menggunakannya sebagai saluran sinkronisasi.",
      "failed_to_broadcast_history_sync": "Gagal menyiarkan sinkronisasi riwayat.",
      "push_notifications_not_supported": "Notifikasi push tidak didukung",
      "notification_permission_denied": "Izin notifikasi ditolak",
      "failed_to_enable_notifications_error_ins": "Gagal mengaktifkan notifikasi: {{error}}",
      "failed_to_enable_notifications": "Gagal mengaktifkan notifikasi: {{error}}",
      "failed_to_disable_notifications": "Gagal menonaktifkan notifikasi",
      "disconnected_reconnecting": "Terputus. Menghubungkan kembali...",
      "this_session_has_been_logged_out_remotel": "Sesi ini telah dikeluarkan dari jarak jauh.",
      "failed_to_load_metrics": "Gagal memuat metrik",
      "access_denied": "Akses Ditolak",
      "something_went_wrong_when_decrypting": "Terjadi kesalahan saat dekripsi.",
      "terjadi_kesalahan_saat_dekripsi": "Terjadi kesalahan saat dekripsi.",
      "could_not_decrypt_your_stored_keys_pleas": "Tidak dapat mendekripsi kunci Anda yang tersimpan. Silakan pulihkan akun Anda jika kata sandi telah berubah.",
      "only_the_group_creator_can_delete_the_gr": "Hanya pembuat grup yang dapat menghapus grup.",
      "failed_to_repair_session": "Gagal memperbaiki sesi.",
      "you_must_restore_your_keys_from_your_rec": "Anda harus memulihkan kunci Anda dari frasa pemulihan sebelum Anda dapat mengirim pesan.",
      "conversation_not_found": "Obrolan tidak ditemukan.",
      "sandbox_limit_reached_verify_your_accoun": "Batas sandbox tercapai! Verifikasi akun Anda untuk membuka perpesanan tak terbatas.",
      "failed_to_send_reaction": "Gagal mengirim reaksi",
      "internal_error_active_conversation_not_f": "Kesalahan internal: Obrolan aktif tidak ditemukan.",
      "user_not_authenticated": "Pengguna belum diautentikasi.",
      "cannot_retry_file_messages_automatically": "Tidak dapat mencoba ulang pesan file secara otomatis. Silakan coba unggah lagi.",
      "failed_to_establish_group_session": "Gagal membuat sesi grup: {{error}}",
      "file_upload_failed": "Gagal mengunggah file: {{error}}",
      "voice_message_failed": "Pesan suara gagal: {{error}}",
      "failed_to_upload_file": "Gagal mengunggah {{filename}}"
    },
    common: {
      "device_revoked_successfully": "Perangkat berhasil dicabut",
      "history_sync_payload_broadcasted_success": "Payload sinkronisasi riwayat berhasil disiarkan.",
      "notifications_enabled": "Notifikasi diaktifkan!",
      "notifications_disabled": "Notifikasi dinonaktifkan",
      "profile_updated": "Profil diperbarui!",
      "processing_avatar": "Memproses avatar...",
      "blocking_user": "Memblokir pengguna...",
      "unblocking_user": "Membuka blokir pengguna...",
      "secure_session_state_reset_next_message_": "Status sesi aman direset. Pesan berikutnya akan menegosiasikan kunci baru.",
      "preparing_history_sync_for_your_linked_d": "Menyiapkan sinkronisasi riwayat untuk perangkat tertaut Anda...",
      "receiving_history_sync_from_your_other_d": "Menerima sinkronisasi riwayat dari perangkat Anda yang lain...",
      "posting_story": "Memposting cerita...",
      "added_to_group": "Anda telah ditambahkan ke \"{{groupName}}\"",
      "user_unbanned": "Pengguna @{{username}} telah di-unban!"
    },
    settings: {
      "linked_devices": {
        "title": "Perangkat Tertaut",
        "desc": "Kelola perangkat yang dapat mendekripsi pesan Anda.",
        "sync_history": "Sinkronkan Riwayat",
        "loading": "Memuat perangkat...",
        "unknown_device": "Perangkat Tidak Dikenal",
        "this_device": "Perangkat Ini",
        "last_active": "Terakhir aktif:",
        "revoke_access": "Cabut Akses",
        "revoke_title": "Cabut Perangkat",
        "revoke_desc": "Apakah Anda yakin ingin mengeluarkan perangkat ini? Ia akan kehilangan akses ke semua obrolan terenkripsi."
      }
    },
    admin: {
      "title": "NYX MISSION CONTROL",
      "refresh": "Segarkan Data",
      "vps_ram": "PENGGUNAAN RAM VPS",
      "uptime": "Waktu Aktif:",
      "active_db": "DATABASE AKTIF",
      "users": "Pengguna",
      "messages": "Pesan",
      "storage": "PENYIMPANAN R2",
      "files": "File",
      "enforcement": "PENEGAKAN",
      "suspend_desc": "Tangguhkan akses pengguna segera. Tindakan ini akan memutus koneksi pengguna secara paksa dan mencegah login di masa mendatang.",
      "open_ban_terminal": "BUKA TERMINAL BLOKIR",
      "suspended_accounts": "AKUN YANG DITANGGUHKAN",
      "no_active_suspensions": "Tidak ada penangguhan aktif",
      "reason": "Alasan:",
      "banned": "Diblokir:",
      "unban": "Buka Blokir",
      "unban_title": "Buka Blokir Pengguna",
      "unban_desc": "Apakah Anda yakin ingin mencabut blokir untuk @{{username}}?",
      "initializing": "MENGINISIALISASI TAUTAN SISTEM..."
    }
  },
  es: {
    errors: {
      "failed_to_load_linked_devices": "Error al cargar los dispositivos vinculados",
      "failed_to_revoke_device": "Error al revocar el dispositivo",
      "please_start_a_chat_with_yourself_saved_": "Por favor, inicie un chat con usted mismo ('Mensajes Guardados') primero para usarlo como canal de sincronización.",
      "failed_to_broadcast_history_sync": "Error al transmitir la sincronización del historial.",
      "push_notifications_not_supported": "Notificaciones push no compatibles",
      "notification_permission_denied": "Permiso de notificación denegado",
      "failed_to_enable_notifications_error_ins": "Error al habilitar notificaciones: {{error}}",
      "failed_to_enable_notifications": "Error al habilitar notificaciones: {{error}}",
      "failed_to_disable_notifications": "Error al deshabilitar las notificaciones",
      "disconnected_reconnecting": "Desconectado. Reconectando...",
      "this_session_has_been_logged_out_remotel": "Esta sesión ha sido cerrada remotamente.",
      "failed_to_load_metrics": "Error al cargar métricas",
      "access_denied": "Acceso denegado",
      "something_went_wrong_when_decrypting": "Algo salió mal al descifrar.",
      "terjadi_kesalahan_saat_dekripsi": "Ocurrió un error durante el descifrado.",
      "could_not_decrypt_your_stored_keys_pleas": "No se pudieron descifrar las claves almacenadas. Recupere su cuenta si la contraseña ha cambiado.",
      "only_the_group_creator_can_delete_the_gr": "Solo el creador del grupo puede eliminar el grupo.",
      "failed_to_repair_session": "Error al reparar la sesión.",
      "you_must_restore_your_keys_from_your_rec": "Debe recuperar sus claves de su frase de recuperación antes de poder enviar mensajes.",
      "conversation_not_found": "Conversación no encontrada.",
      "sandbox_limit_reached_verify_your_accoun": "¡Límite de sandbox alcanzado! Verifique su cuenta para desbloquear mensajes ilimitados.",
      "failed_to_send_reaction": "Error al enviar la reacción",
      "internal_error_active_conversation_not_f": "Error interno: No se encontró la conversación activa.",
      "user_not_authenticated": "Usuario no autenticado.",
      "cannot_retry_file_messages_automatically": "No se pueden volver a intentar los mensajes de archivo automáticamente. Intente cargar nuevamente.",
      "failed_to_establish_group_session": "Error al establecer sesión de grupo: {{error}}",
      "file_upload_failed": "Error en la subida de archivo: {{error}}",
      "voice_message_failed": "Error en el mensaje de voz: {{error}}",
      "failed_to_upload_file": "Error al subir {{filename}}"
    },
    common: {
      "device_revoked_successfully": "Dispositivo revocado con éxito",
      "history_sync_payload_broadcasted_success": "Sincronización del historial transmitida con éxito.",
      "notifications_enabled": "¡Notificaciones habilitadas!",
      "notifications_disabled": "Notificaciones deshabilitadas",
      "profile_updated": "¡Perfil actualizado!",
      "processing_avatar": "Procesando avatar...",
      "blocking_user": "Bloqueando usuario...",
      "unblocking_user": "Desbloqueando usuario...",
      "secure_session_state_reset_next_message_": "Estado de sesión segura restablecido. El próximo mensaje negociará nuevas claves.",
      "preparing_history_sync_for_your_linked_d": "Preparando la sincronización del historial para sus dispositivos vinculados...",
      "receiving_history_sync_from_your_other_d": "Recibiendo la sincronización del historial de su otro dispositivo...",
      "posting_story": "Publicando historia...",
      "added_to_group": "Has sido añadido a \"{{groupName}}\"",
      "user_unbanned": "¡Usuario @{{username}} desbaneado!"
    },
    settings: {
      "linked_devices": {
        "title": "Dispositivos Vinculados",
        "desc": "Administre los dispositivos que pueden descifrar sus mensajes.",
        "sync_history": "Sincronizar Historial",
        "loading": "Cargando dispositivos...",
        "unknown_device": "Dispositivo Desconocido",
        "this_device": "Este Dispositivo",
        "last_active": "Última vez activo:",
        "revoke_access": "Revocar Acceso",
        "revoke_title": "Revocar Dispositivo",
        "revoke_desc": "¿Estás seguro de que deseas cerrar sesión en este dispositivo? Perderá el acceso a todos los chats cifrados."
      }
    },
    admin: {
      "title": "NYX MISSION CONTROL",
      "refresh": "Actualizar Datos",
      "vps_ram": "USO DE RAM VPS",
      "uptime": "Tiempo de actividad:",
      "active_db": "BASE DE DATOS ACTIVA",
      "users": "Usuarios",
      "messages": "Mensajes",
      "storage": "ALMACENAMIENTO R2",
      "files": "Archivos",
      "enforcement": "CUMPLIMIENTO",
      "suspend_desc": "Suspenda el acceso del usuario inmediatamente. Esta acción desconectará al usuario por la fuerza y evitará futuros inicios de sesión.",
      "open_ban_terminal": "ABRIR TERMINAL DE BLOQUEO",
      "suspended_accounts": "CUENTAS SUSPENDIDAS",
      "no_active_suspensions": "No hay suspensiones activas",
      "reason": "Razón:",
      "banned": "Bloqueado:",
      "unban": "Desbloquear",
      "unban_title": "Desbloquear Usuario",
      "unban_desc": "¿Estás seguro de que deseas levantar el bloqueo para @{{username}}?",
      "initializing": "INICIALIZANDO ENLACE DE SISTEMA..."
    }
  },
  "pt-BR": {
    errors: {
      "failed_to_load_linked_devices": "Falha ao carregar dispositivos vinculados",
      "failed_to_revoke_device": "Falha ao revogar dispositivo",
      "please_start_a_chat_with_yourself_saved_": "Por favor, inicie um chat consigo mesmo ('Mensagens Salvas') primeiro para usar como canal de sincronização.",
      "failed_to_broadcast_history_sync": "Falha ao transmitir sincronização do histórico.",
      "push_notifications_not_supported": "Notificações push não suportadas",
      "notification_permission_denied": "Permissão de notificação negada",
      "failed_to_enable_notifications_error_ins": "Falha ao ativar notificações: {{error}}",
      "failed_to_enable_notifications": "Falha ao ativar notificações: {{error}}",
      "failed_to_disable_notifications": "Falha ao desativar notificações",
      "disconnected_reconnecting": "Desconectado. Reconectando...",
      "this_session_has_been_logged_out_remotel": "Esta sessão foi desconectada remotamente.",
      "failed_to_load_metrics": "Falha ao carregar métricas",
      "access_denied": "Acesso negado",
      "something_went_wrong_when_decrypting": "Algo deu errado ao descriptografar.",
      "terjadi_kesalahan_saat_dekripsi": "Ocorreu um erro durante a descriptografia.",
      "could_not_decrypt_your_stored_keys_pleas": "Não foi possível descriptografar as chaves armazenadas. Restaure sua conta se a senha mudou.",
      "only_the_group_creator_can_delete_the_gr": "Apenas o criador do grupo pode excluí-lo.",
      "failed_to_repair_session": "Falha ao reparar a sessão.",
      "you_must_restore_your_keys_from_your_rec": "Você deve restaurar as chaves da sua frase de recuperação antes de enviar mensagens.",
      "conversation_not_found": "Conversa não encontrada.",
      "sandbox_limit_reached_verify_your_accoun": "Limite do sandbox atingido! Verifique sua conta para desbloquear mensagens ilimitadas.",
      "failed_to_send_reaction": "Falha ao enviar reação",
      "internal_error_active_conversation_not_f": "Erro interno: Conversa ativa não encontrada.",
      "user_not_authenticated": "Usuário não autenticado.",
      "cannot_retry_file_messages_automatically": "Não é possível tentar mensagens de arquivo novamente de forma automática. Tente enviar novamente.",
      "failed_to_establish_group_session": "Falha ao estabelecer sessão em grupo: {{error}}",
      "file_upload_failed": "Falha no upload do arquivo: {{error}}",
      "voice_message_failed": "Mensagem de voz falhou: {{error}}",
      "failed_to_upload_file": "Falha ao fazer upload de {{filename}}"
    },
    common: {
      "device_revoked_successfully": "Dispositivo revogado com sucesso",
      "history_sync_payload_broadcasted_success": "Sincronização do histórico transmitida com sucesso.",
      "notifications_enabled": "Notificações ativadas!",
      "notifications_disabled": "Notificações desativadas",
      "profile_updated": "Perfil atualizado!",
      "processing_avatar": "Processando avatar...",
      "blocking_user": "Bloqueando usuário...",
      "unblocking_user": "Desbloqueando usuário...",
      "secure_session_state_reset_next_message_": "Estado de sessão segura redefinido. A próxima mensagem negociará novas chaves.",
      "preparing_history_sync_for_your_linked_d": "Preparando sincronização de histórico para seus dispositivos vinculados...",
      "receiving_history_sync_from_your_other_d": "Recebendo sincronização de histórico do seu outro dispositivo...",
      "posting_story": "Publicando história...",
      "added_to_group": "Você foi adicionado a \"{{groupName}}\"",
      "user_unbanned": "Usuário @{{username}} desbanido!"
    },
    settings: {
      "linked_devices": {
        "title": "Dispositivos Vinculados",
        "desc": "Gerencie dispositivos que podem descriptografar suas mensagens.",
        "sync_history": "Sincronizar Histórico",
        "loading": "Carregando dispositivos...",
        "unknown_device": "Dispositivo Desconhecido",
        "this_device": "Este Dispositivo",
        "last_active": "Última atividade:",
        "revoke_access": "Revogar Acesso",
        "revoke_title": "Revogar Dispositivo",
        "revoke_desc": "Tem certeza que deseja sair deste dispositivo? Ele perderá acesso a todos os chats criptografados."
      }
    },
    admin: {
      "title": "NYX MISSION CONTROL",
      "refresh": "Atualizar Dados",
      "vps_ram": "USO DE RAM DO VPS",
      "uptime": "Tempo de atividade:",
      "active_db": "BANCO DE DADOS ATIVO",
      "users": "Usuários",
      "messages": "Mensagens",
      "storage": "ARMAZENAMENTO R2",
      "files": "Arquivos",
      "enforcement": "APLICAÇÃO",
      "suspend_desc": "Suspenda o acesso do usuário imediatamente. Esta ação desconectará o usuário à força e impedirá logins futuros.",
      "open_ban_terminal": "ABRIR TERMINAL DE BANIMENTO",
      "suspended_accounts": "CONTAS SUSPENSAS",
      "no_active_suspensions": "Nenhuma suspensão ativa",
      "reason": "Motivo:",
      "banned": "Banido:",
      "unban": "Desbanir",
      "unban_title": "Desbanir Usuário",
      "unban_desc": "Tem certeza que deseja remover o banimento de @{{username}}?",
      "initializing": "INICIALIZANDO LINK DO SISTEMA..."
    }
  }
};

Object.keys(dict).forEach(lang => {
  Object.keys(dict[lang]).forEach(ns => {
    let p = path.join(localesPath, `${lang}/${ns}.json`);
    if (fs.existsSync(p)) {
      let d = JSON.parse(fs.readFileSync(p, 'utf8'));
      // Merge translated strings
      for (const [key, value] of Object.entries(dict[lang][ns])) {
        // Handle nested objects like linked_devices
        if (typeof value === 'object' && value !== null) {
          if (!d[key]) d[key] = {};
          d[key] = { ...d[key], ...value };
        } else {
          d[key] = value;
        }
      }
      fs.writeFileSync(p, JSON.stringify(d, null, 2));
    }
  });
});
