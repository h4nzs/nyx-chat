import { TransportOpCode, MainToTransportWorker, TransportWorkerToMain } from '@nyx/shared';

let transport: WebTransport | null = null;
let controlStream: WebTransportBidirectionalStream | null = null;
let controlWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
let datagramWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;

async function initWebTransport(url: string, token: string, certificateHash?: string) {
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
      postMessage({ 
        type: 'DISCONNECTED', 
        reason: info?.reason || 'connection closed' 
      } satisfies TransportWorkerToMain);
    }).catch((err) => {
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
    
    const tokenBytes = new TextEncoder().encode(token);
    // Simple framing: OP_CODE (0x00 for auth) + length + token
    const authFrame = new Uint8Array(1 + 4 + tokenBytes.length);
    authFrame[0] = 0x00;
    const view = new DataView(authFrame.buffer);
    view.setUint32(1, tokenBytes.length, false); // Big endian
    authFrame.set(tokenBytes, 5);
    
    await controlWriter.write(authFrame);

    postMessage({ type: 'CONNECTED' } satisfies TransportWorkerToMain);

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
      await initWebTransport(data.url, data.token, data.certificateHash);
      break;
    case 'DISCONNECT':
      if (transport) {
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
        try {
          const stream = await transport.createUnidirectionalStream();
          const writer = stream.getWriter();
          
          const frame = new Uint8Array(5 + data.payload.length);
          frame[0] = data.opCode;
          const view = new DataView(frame.buffer);
          view.setUint32(1, data.payload.length, false);
          frame.set(data.payload, 5);
          
          await writer.write(frame);
          await writer.close();
        } catch (e) {
          console.error("Failed to send stream", e);
        }
      }
      break;
    case 'SEND_DATAGRAM':
      if (transport && datagramWriter) {
        try {
          const frame = new Uint8Array(5 + data.payload.length);
          frame[0] = data.opCode;
          const view = new DataView(frame.buffer);
          view.setUint32(1, data.payload.length, false);
          frame.set(data.payload, 5);
          
          await datagramWriter.write(frame);
        } catch (e) {
          console.error("Failed to send datagram", e);
        }
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
