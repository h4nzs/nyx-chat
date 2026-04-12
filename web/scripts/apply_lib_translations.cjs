const fs = require('fs');
const path = require('path');

const data = {
  en: {
    errors: {
      "failed_to_rotate_group_keys": "CRITICAL: Failed to rotate keys for group. The chat is insecure.",
      "media_error": "Media Error: {{error}}",
      "call_failed": "Failed to start E2EE call."
    },
    chat: {
      "messages.message_retracted": "A message has been retracted by the sender."
    },
    common: {
      "security_key_changed": "The security key for {{name}} has changed. You may want to verify their identity."
    }
  },
  id: {
    errors: {
      "failed_to_rotate_group_keys": "KRITIS: Gagal memutar kunci untuk grup. Obrolan menjadi tidak aman.",
      "media_error": "Kesalahan Media: {{error}}",
      "call_failed": "Gagal memulai panggilan E2EE."
    },
    chat: {
      "messages.message_retracted": "Sebuah pesan telah ditarik oleh pengirim."
    },
    common: {
      "security_key_changed": "Kunci keamanan untuk {{name}} telah berubah. Anda mungkin ingin memverifikasi identitas mereka."
    }
  },
  es: {
    errors: {
      "failed_to_rotate_group_keys": "CRÍTICO: Error al rotar las claves del grupo. El chat es inseguro.",
      "media_error": "Error de medios: {{error}}",
      "call_failed": "Error al iniciar la llamada E2EE."
    },
    chat: {
      "messages.message_retracted": "El remitente ha retirado un mensaje."
    },
    common: {
      "security_key_changed": "La clave de seguridad de {{name}} ha cambiado. Es posible que desee verificar su identidad."
    }
  },
  "pt-BR": {
    errors: {
      "failed_to_rotate_group_keys": "CRÍTICO: Falha ao rotacionar chaves para o grupo. O chat está inseguro.",
      "media_error": "Erro de mídia: {{error}}",
      "call_failed": "Falha ao iniciar chamada E2EE."
    },
    chat: {
      "messages.message_retracted": "Uma mensagem foi retratada pelo remetente."
    },
    common: {
      "security_key_changed": "A chave de segurança de {{name}} mudou. Você pode querer verificar a identidade deles."
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
