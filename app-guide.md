<meta http-equiv="Content-Security-Policy" content="
      default-src 'self';
      script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://challenges.cloudflare.com https://static.cloudflareinsights.com https://cloudflareinsights.com https://*.cloudflare.com;
      worker-src 'self' blob:;
      style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
      img-src 'self' data: blob: https://api.dicebear.com https://*.r2.dev https://cdn.jsdelivr.net https://*.cloudflarestorage.com;
      media-src 'self' blob: https://*.r2.dev https://*.cloudflarestorage.com;
      font-src 'self' https://fonts.gstatic.com;
      connect-src 'self' https://api.nyx-app.my.id wss://api.nyx-app.my.id https://nyx-app.my.id wss://nyx-app.my.id https://*.cloudflareinsights.com https://cloudflareinsights.com https://*.r2.dev https://*.cloudflarestorage.com;
      frame-src 'self' https://challenges.cloudflare.com;
    ">