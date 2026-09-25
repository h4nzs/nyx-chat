import { TransportOpCode, MainToTransportWorker, TransportWorkerToMain } from '@nyx/shared';

let transport: WebTransport | null = null;
let controlStream: WebTransportBidirectionalStream | null = null;
let controlWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
let datagramWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;

// --- TRAFFIC COVER: CHAFFING ---
const CHAFF_INTERVAL_MS = 3000;
const CHAFF_JITTER_MS = 500;
// Ukuran chaff ≤ MTU datagram QUIC (~1200B) agar tidak drop diam-diam.
const CHAFF_DATAGRAM_SIZE = 1000;
let isChaffingActive = false;

// Serialisasi pengiriman frame (FIFO) tanpa delay buatan:
// pesan asli dikirim SEKETIKA, chaff dummy dikirim oleh loop interval.
let sendChain: Promise<void> = Promise.resolve();
let pendingSends = 0;

// Perbaikan #5: antrean fallback untuk frame gagal kirim (bukan chaff).
// Sebelumnya enqueueSend menelan error kirim — pesan user bisa hilang diam-diam
// saat transport tertutup di tengah pengiriman. Frame yang gagal kini disimpan
// dan di-flush ulang ke sendChain saat koneksi pulih (CONNECTED).
// Koneksi putus lebih awal (transport null) ditangani offlineQueue di
// transportClient.ts — di sini hanya error PENGIRIMAN yang di-re-queue.
const MAX_RETRY_QUEUE = 200;
const retryQueue: { item: { opCode: number, payload: Uint8Array, useStream: boolean }, attempts: number }[] = [];
let flushingRetries = false;

const RETRYABLE_OPCODES = new Set<number>([
    TransportOpCode.CHAT_MESSAGE,
    TransportOpCode.KEY_SYNC,
    TransportOpCode.PRESENCE,
]);

function flushRetryQueue() {
    if (flushingRetries || retryQueue.length === 0) return;
    flushingRetries = true;
    // Salin & kosongkan antrean; jika flush ulang gagal lagi, item akan
    // masuk antrean lagi di catch (serahkan ke sendChain agar FIFO terjaga).
    const pending = retryQueue.splice(0, retryQueue.length);
    for (const entry of pending) {
        enqueueSend(entry.item, entry.attempts);
    }
    flushingRetries = false;
}

async function sendFrameItem(item: { opCode: number, payload: Uint8Array, useStream: boolean }) {
  if (!transport) return;
  if (item.useStream) {
    const stream = await transport.createUnidirectionalStream();
    const writer = stream.getWriter();
    const frame = new Uint8Array(5 + item.payload.length);
    frame[0] = item.opCode;
    new DataView(frame.buffer).setUint32(1, item.payload.length, false);
    frame.set(item.payload, 5);
    await writer.write(frame);
    await writer.close();
  } else if (datagramWriter) {
    const frame = new Uint8Array(5 + item.payload.length);
    frame[0] = item.opCode;
    new DataView(frame.buffer).setUint32(1, item.payload.length, false);
    frame.set(item.payload, 5);
    await datagramWriter.write(frame);
  }
}

function enqueueSend(item: { opCode: number, payload: Uint8Array, useStream: boolean }, attempts = 0) {
  pendingSends++;
  if (import.meta.env.DEV && pendingSends > 10) {
    console.debug(`[perf:transport] send chain depth ${pendingSends}`);
  }
  sendChain = sendChain
    .then(() => sendFrameItem(item))
    .catch((e) => {
      // Expected race saat koneksi baru saja tertutup (reconnect) — bukan error nyata
      console.debug("Transport: failed to send frame (connection closing):", e instanceof Error ? e.message : e);
      // Perbaikan #5: re-queue frame pesan user yang gagal kirim (maks 3 percobaan,
      // maks 200 frame agar memori worker tidak membengkak). Chaff sengaja dibuang:
      // dummy traffic yang hilang tidak berpengaruh.
      if (RETRYABLE_OPCODES.has(item.opCode) && attempts < 3) {
        if (retryQueue.length >= MAX_RETRY_QUEUE) retryQueue.shift();
        retryQueue.push({ item, attempts: attempts + 1 });
      }
    })
    .finally(() => { pendingSends--; });
}

async function chaffingLoop() {
    if (isChaffingActive) return;
    isChaffingActive = true;

    while (isChaffingActive) {
        if (!transport || !datagramWriter) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
        }

        // Generate encrypted-looking dummy data (traffic cover saat idle)
        const dummyPayload = new Uint8Array(CHAFF_DATAGRAM_SIZE);
        self.crypto.getRandomValues(dummyPayload);
        enqueueSend({ opCode: TransportOpCode.CHAFF, payload: dummyPayload, useStream: false });

        // Wait for next interval with jitter
        const jitter = Math.floor(Math.random() * (CHAFF_JITTER_MS * 2)) - CHAFF_JITTER_MS;
        await new Promise(r => setTimeout(r, Math.max(500, CHAFF_INTERVAL_MS + jitter)));
    }
}

function startChaffing() {
    chaffingLoop().catch(console.error);
}

function stopChaffing() {
    isChaffingActive = false;
}

async function initWebTransport(url: string, token: string, certificateHash?: string, deviceIdentity?: string) {
  try {
    const options: WebTransportOptions = {};
    if (certificateHash && certificateHash.trim()) {
      // Robust hash parsing: Remove colons/spaces and verify length
      const hex = certificateHash.replace(/[:\s]/g, '');
      if (hex.length === 64) { // SHA-256 is 32 bytes = 64 hex chars
        const match = hex.match(/.{1,2}/g);
        if (match) {
          const hashArray = new Uint8Array(match.map(byte => parseInt(byte, 16)));
          options.serverCertificateHashes = [{ algorithm: 'sha-256', value: hashArray }];
        }
      }
    }

    transport = new WebTransport(url, options);
    
    // Prevent "Uncaught (in promise)" error when connection is rejected
    transport.closed.then((info) => {
      stopChaffing();
      postMessage({ 
        type: 'DISCONNECTED', 
        reason: info?.reason || 'connection closed' 
      } satisfies TransportWorkerToMain);
    }).catch((err) => {
      stopChaffing();
      postMessage({ 
        type: 'DISCONNECTED', 
        reason: err?.message || 'connection error' 
      } satisfies TransportWorkerToMain);
    });

    await transport.ready;
    
    // Auth stream
    controlStream = await transport.createBidirectionalStream();
    controlWriter = controlStream.writable.getWriter();
    datagramWriter = transport.datagrams.writable.getWriter();
    
    // Auth Payload: Combine JWT Token and Device Identity Metadata
    let parsedIdentity: unknown = null;
    if (deviceIdentity) {
      try { parsedIdentity = JSON.parse(deviceIdentity); } catch (_e) { parsedIdentity = null; }
    }
    const authData = JSON.stringify({ token, identity: parsedIdentity });
    const authBytes = new TextEncoder().encode(authData);
    
    // Simple framing: OP_CODE (0x00 for auth) + length + authData
    const authFrame = new Uint8Array(1 + 4 + authBytes.length);
    authFrame[0] = 0x00;
    const view = new DataView(authFrame.buffer);
    view.setUint32(1, authBytes.length, false); // Big endian
    authFrame.set(authBytes, 5);
    
    await controlWriter.write(authFrame);

    postMessage({ type: 'CONNECTED' } satisfies TransportWorkerToMain);
    startChaffing();
    // Perbaikan #5: kirim ulang frame pesan user yang gagal terkirim pada
    // koneksi sebelumnya (maks 3 percobaan per frame, dilihat enqueueSend).
    flushRetryQueue();

    // Start reading streams
    readIncomingStreams(transport.incomingUnidirectionalStreams).catch(console.error);
    readIncomingBidirectionalStreams(transport.incomingBidirectionalStreams).catch(console.error);
    readIncomingDatagrams(transport.datagrams.readable).catch(console.error);
    
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Connection failed';
    postMessage({ type: 'ERROR', error: msg } satisfies TransportWorkerToMain);
  }
}

async function readIncomingStreams(readable: ReadableStream<ReadableStream<Uint8Array>>) {
  const reader = readable.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        readSingleStream(value).catch(console.error);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function readIncomingBidirectionalStreams(readable: ReadableStream<WebTransportBidirectionalStream>) {
  const reader = readable.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        handleBidirectionalStream(value).catch(console.error);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function handleBidirectionalStream(stream: WebTransportBidirectionalStream) {
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  
  try {
    const { value, done } = await reader.read();
    if (done || !value) return;
    
    const opCode = value[0];
    if (opCode === TransportOpCode.HANDSHAKE) {
      // Process Handshake
      processChunk(value);
      
      // Send back ACK on same stream
      const ackFrame = new Uint8Array([TransportOpCode.ACK, 0, 0, 0, 0]);
      await writer.write(ackFrame);
    } else {
      processChunk(value);
    }
  } finally {
    await writer.close();
    reader.releaseLock();
  }
}

async function readSingleStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        chunks.push(value);
        totalLength += value.byteLength;
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  if (totalLength >= 5) {
    const fullBuffer = new Uint8Array(totalLength);
    let offset = 0;
    for (const c of chunks) {
      fullBuffer.set(c, offset);
      offset += c.byteLength;
    }
    processChunk(fullBuffer);
  }
}

async function readIncomingDatagrams(readable: ReadableStream<Uint8Array>) {
  const reader = readable.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        processChunk(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function processChunk(chunk: Uint8Array) {
  if (chunk.length < 5) return;
  const opCode = chunk[0] as TransportOpCode;
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const length = view.getUint32(1, false); // Big Endian
  
  if (chunk.length < 5 + length) {
    // Basic implementation: assuming frame isn't fragmented.
    // In production, we'd need a buffer to handle fragmented packets.
    return; 
  }
  
  const payload = chunk.subarray(5, 5 + length);
  const copiedPayload = new Uint8Array(payload); // copy to safely transfer
  
  postMessage({
    type: 'DATA_RECEIVED',
    opCode,
    payload: copiedPayload
  } satisfies TransportWorkerToMain, [copiedPayload.buffer]);
}

self.onmessage = async (event: MessageEvent<MainToTransportWorker>) => {
  const data = event.data;
  switch (data.type) {
    case 'CONNECT':
      // Cleanup previous connection if any
      if (transport) {
        try { transport.close(); } catch (e) {}
        transport = null;
      }
      await initWebTransport(data.url, data.token, data.certificateHash, data.deviceIdentity);
      break;
    case 'DISCONNECT':
      if (transport) {
        stopChaffing();
        if (datagramWriter) {
          try { datagramWriter.releaseLock(); } catch (e) {}
          datagramWriter = null;
        }
        transport.close();
        transport = null;
        postMessage({ type: 'DISCONNECTED', reason: 'client closed' } satisfies TransportWorkerToMain);
      }
      break;
    case 'SEND_STREAM':
      if (transport) {
        enqueueSend({ opCode: data.opCode, payload: data.payload, useStream: true });
      }
      break;
    case 'SEND_DATAGRAM':
      if (transport) {
        enqueueSend({ opCode: data.opCode, payload: data.payload, useStream: false });
      }
      break;
    case 'START_HANDSHAKE':
      if (transport) {
        let stream: WebTransportBidirectionalStream | null = null;
        try {
          stream = await transport.createBidirectionalStream();
          const writer = stream.writable.getWriter();
          const reader = stream.readable.getReader();
          
          const frame = new Uint8Array(5 + data.payload.length);
          frame[0] = TransportOpCode.HANDSHAKE;
          const view = new DataView(frame.buffer);
          view.setUint32(1, data.payload.length, false);
          frame.set(data.payload, 5);
          
          await writer.write(frame);
          await writer.close();
          
          // Timeout & Retry Logic (5 seconds)
          const timeoutPromise = new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('Handshake timeout')), 5000)
          );
          
          const readPromise = (async () => {
            const { value, done } = await reader.read();
            if (done || !value) throw new Error('Stream closed prematurely');
            
            // Check for ACK OpCode
            if (value[0] === TransportOpCode.ACK || value[0] === TransportOpCode.HANDSHAKE) {
                return true;
            }
            throw new Error('Invalid handshake response');
          })();
          
          await Promise.race([readPromise, timeoutPromise]);
          
          postMessage({ type: 'HANDSHAKE_COMPLETED', success: true } satisfies TransportWorkerToMain);
          
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : 'Handshake failed';
          console.error("Handshake failed:", e);
          postMessage({ 
            type: 'HANDSHAKE_COMPLETED', 
            success: false, 
            error: msg 
          } satisfies TransportWorkerToMain);
        } finally {
            // Reader cleanup is handled by GC or explicit release if needed
        }
      }
      break;
  }
};
