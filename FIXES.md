**GAS KOMANDAN! KITA SIKAT SEKARANG! 🏴‍☠️🔥**

Keputusan yang sangat tepat. Kalau kita mau mengklaim NYX ini selevel Signal atau Session, kita **WAJIB** punya TURN Server sendiri untuk mencegah IP Leak.

Karena lu udah pakai infrastruktur Docker Compose, nambahin TURN server itu gampang banget. Kita bakal pakai *image* resmi **Coturn** (`coturn/coturn`), yang merupakan standar industri *open-source* paling tangguh saat ini.

### 🗺️ BATTLE PLAN: THE CYPHERPUNK RELAY

1. **Update Docker Compose:** Kita tambahin *container* `coturn` barengan sama `postgres`, `redis`, dll. Kita batesin *port relay*-nya (misal: 50000-50050) biar VPS Oracle lu nggak meledak ngurusin puluhan ribu *port firewall*.
2. **Update Environment:** Kita masukin *username* dan *password* TURN ke `.env`.
3. **Hardcore WebRTC Config:** Di `webrtc.ts`, kita tambahin server TURN lu. Dan yang paling ekstrem: kita bisa pasang aturan `iceTransportPolicy: 'relay'` buat **MEMAKSA** panggilan selalu lewat server, sehingga IP asli 100% mustahil bocor!

Silakan *copy-paste* prompt ini ke Cursor / Gemini CLI lu:

---

**COPY DARI SINI:**

---

**ROLE & CONTEXT:**
You are a Cypherpunk DevOps Architect. We are upgrading our E2EE Chat App (NYX) to prevent WebRTC IP Leaks (which occur during P2P ICE candidate exchange). We need to deploy our own TURN Server using `coturn/coturn` via Docker Compose and configure the frontend WebRTC engine to utilize it securely.

**TASK 1: ADD COTURN TO DOCKER COMPOSE**
**File:** `docker-compose.yml`
**Action:** Add the `coturn` service. We will restrict the UDP relay ports to 50000-50050 to save iptables resources on the VPS.
**Implementation:** Add this service right below the `redis` service:

```yaml
  # 2.5 TURN Server (Coturn for WebRTC IP-Leak Protection)
  coturn:
    image: coturn/coturn:latest
    container_name: nyx-turn
    restart: always
    network_mode: "host" # Host mode is highly recommended for TURN servers to handle UDP packet routing cleanly
    command:
      - "-n"
      - "--log-file=stdout"
      - "--min-port=50000"
      - "--max-port=50050"
      - "--user=${TURN_USERNAME:-nyx}:${TURN_PASSWORD:-cypherpunk2077}"
      - "--realm=${TURN_REALM:-nyx-app.my.id}"
      - "--listening-port=3478"

```

*(Note: Remove the `networks: - chat-net` for coturn since we are using `network_mode: "host"` which is best practice for Coturn behind NAT).*

**TASK 2: UPDATE FRONTEND ENVIRONMENT**
**File:** `web/.env.example`
**Action:** Add the TURN configuration variables.
**Implementation:** Append these lines:

```env
# WebRTC TURN Server (Anti IP-Leak)
VITE_TURN_URL="turn:turn.nyx-app.my.id:3478" # Replace with your VPS IP or Domain
VITE_TURN_USERNAME="nyx"
VITE_TURN_PASSWORD="cypherpunk2077"

```

**TASK 3: CONFIGURE WEBRTC ENGINE FOR RELAY**
**File:** `web/src/lib/webrtc.ts`
**Action:** Update the `ICE_SERVERS` configuration to include the TURN server from environment variables.
**Implementation:**

```typescript
const TURN_URL = import.meta.env.VITE_TURN_URL;
const TURN_USER = import.meta.env.VITE_TURN_USERNAME;
const TURN_PASS = import.meta.env.VITE_TURN_PASSWORD;

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }, // Fallback STUN
    ...(TURN_URL && TURN_USER && TURN_PASS ? [{
      urls: TURN_URL,
      username: TURN_USER,
      credential: TURN_PASS
    }] : [])
  ],
  // OPTIONAL CYPHERPUNK MODE: Uncomment the line below to FORCE relay and guarantee 0% IP Leak.
  // Note: Forcing relay increases server bandwidth usage and prevents direct LAN connections.
  // iceTransportPolicy: 'relay', 
};

```

**EXECUTION:**
Apply these configurations. Ensure the YAML indentation is perfectly aligned.

---

**SELESAI COPY**

---

### ⚠️ PERHATIAN KHUSUS BUAT ORACLE CLOUD (VPS) LU!

Nambahin kode di atas aja **BELUM CUKUP** buat bikin videonya nyambung kalau lu *deploy* ke Oracle. Oracle Cloud itu terkenal punya *Firewall* lapis ganda yang super ketat.

Setelah lu nge-*deploy* *compose* baru ini ke VPS, lu **WAJIB** melakukan 2 hal ini di server lu:

1. **Buka Port di Oracle Web Console (Ingress Rules):**
* Masuk ke *dashboard* Oracle Cloud.
* Pergi ke VCN -> Subnets -> Default Security List.
* Tambahkan *Ingress Rule*:
* Protokol: **TCP & UDP**, Destination Port: **3478**
* Protokol: **UDP**, Destination Port Range: **50000-50050**




2. **Buka Port di OS iptables/ufw (SSH ke VPS):**
* Eksekusi *command* ini di terminal VPS lu:


```bash
sudo iptables -I INPUT -p tcp --dport 3478 -j ACCEPT
sudo iptables -I INPUT -p udp --dport 3478 -j ACCEPT
sudo iptables -I INPUT -p udp --dport 50000:50050 -j ACCEPT
sudo netfilter-persistent save

```



*(Kalau lu belum siap buka-buka port di Oracle malam ini, biarin `iceTransportPolicy: 'relay'` di `webrtc.ts` **dikomen / dimatikan** dulu. Biar *call*-nya tetap bisa jalan pakai STUN Google).*

Sikat Komandan! Infrastruktur lu sekarang resmi jadi ISP Mini! 🌐📞