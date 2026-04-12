const fs = require('fs');
const path = require('path');

const data = {
  en: {
    common: {
      "uploading_to_cloud": "Uploading to Cloud...",
      "avatar_uploaded": "Avatar uploaded! (Profile update required)",
      "user_blocked": "User blocked",
      "user_unblocked": "User unblocked"
    },
    errors: {
      "update_failed": "Update failed: {{error}}",
      "block_failed": "Block failed: {{error}}",
      "unblock_failed": "Unblock failed: {{error}}",
      "failed_to_delete_conversation": "Failed to delete conversation.",
      "failed_to_delete_group": "Failed to delete group.",
      "failed_to_toggle_pinned_conversation": "Failed to toggle pinned conversation."
    }
  },
  id: {
    common: {
      "uploading_to_cloud": "Mengunggah ke Cloud...",
      "avatar_uploaded": "Avatar diunggah! (Pembaruan profil diperlukan)",
      "user_blocked": "Pengguna diblokir",
      "user_unblocked": "Blokir pengguna dibuka"
    },
    errors: {
      "update_failed": "Pembaruan gagal: {{error}}",
      "block_failed": "Gagal memblokir: {{error}}",
      "unblock_failed": "Gagal membuka blokir: {{error}}",
      "failed_to_delete_conversation": "Gagal menghapus obrolan.",
      "failed_to_delete_group": "Gagal menghapus grup.",
      "failed_to_toggle_pinned_conversation": "Gagal menyematkan/melepas sematan obrolan."
    }
  },
  es: {
    common: {
      "uploading_to_cloud": "Subiendo a la nube...",
      "avatar_uploaded": "¡Avatar subido! (Requiere actualización del perfil)",
      "user_blocked": "Usuario bloqueado",
      "user_unblocked": "Usuario desbloqueado"
    },
    errors: {
      "update_failed": "Error en la actualización: {{error}}",
      "block_failed": "Error al bloquear: {{error}}",
      "unblock_failed": "Error al desbloquear: {{error}}",
      "failed_to_delete_conversation": "Error al eliminar la conversación.",
      "failed_to_delete_group": "Error al eliminar el grupo.",
      "failed_to_toggle_pinned_conversation": "Error al fijar/desfijar la conversación."
    }
  },
  "pt-BR": {
    common: {
      "uploading_to_cloud": "Enviando para a nuvem...",
      "avatar_uploaded": "Avatar enviado! (Requer atualização do perfil)",
      "user_blocked": "Usuário bloqueado",
      "user_unblocked": "Usuário desbloqueado"
    },
    errors: {
      "update_failed": "Falha na atualização: {{error}}",
      "block_failed": "Falha ao bloquear: {{error}}",
      "unblock_failed": "Falha ao desbloquear: {{error}}",
      "failed_to_delete_conversation": "Falha ao excluir conversa.",
      "failed_to_delete_group": "Falha ao excluir grupo.",
      "failed_to_toggle_pinned_conversation": "Falha ao fixar/desafixar conversa."
    }
  }
};

Object.keys(data).forEach(lang => {
  Object.keys(data[lang]).forEach(ns => {
    const p = path.join(__dirname, '../public/locales', lang, `${ns}.json`);
    let d = {};
    if (fs.existsSync(p)) {
      d = JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    
    for (const [dotPath, val] of Object.entries(data[lang][ns])) {
      const parts = dotPath.split('.');
      let current = d;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!current[parts[i]]) current[parts[i]] = {};
        current = current[parts[i]];
      }
      current[parts[parts.length - 1]] = val;
    }
    
    fs.writeFileSync(p, JSON.stringify(d, null, 2));
  });
});

console.log("Updated new translation keys in all languages!");
