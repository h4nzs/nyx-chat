import { TransportOpCode, MainToTransportWorker, TransportWorkerToMain } from '@nyx/shared';

let transport: WebTransport | null = null;
let controlStream: WebTransportBidirectionalStream | null = null;
let controlWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;

async function initWebTransport(url: string, token: string, certificateHash?: string) {
  try {
    const options: WebTransportOptions = {};
    if (certificateHash) {
      // Remove colons if present and convert hex to Uint8Array
      const hex = certificateHash.replace(/:/g, '');
      const hashArray = new Uint8Array(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
      options.serverCertificateHashes = [{ algorithm: 'sha-256', value: hashArray }];
    }

    transport = new WebTransport(url, options);
    await transport.ready;
    
    // Auth stream
    controlStream = await transport.createBidirectionalStream();
    controlWriter = controlStream.writable.getWriter();
    
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
    readIncomingDatagrams(transport.datagrams.readable).catch(console.error);
    
  } catch (error: any) {
    postMessage({ type: 'ERROR', error: error?.message || 'Connection failed' } satisfies TransportWorkerToMain);
  }
}

async function readIncomingStreams(readable: ReadableStream<any>) {
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

async function readSingleStream(stream: any) {
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
      await initWebTransport(data.url, data.token, data.certificateHash);
      break;
    case 'DISCONNECT':
      if (transport) {
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
      if (transport) {
        try {
          const writer = transport.datagrams.writable.getWriter();
          const frame = new Uint8Array(5 + data.payload.length);
          frame[0] = data.opCode;
          const view = new DataView(frame.buffer);
          view.setUint32(1, data.payload.length, false);
          frame.set(data.payload, 5);
          
          await writer.write(frame);
          writer.releaseLock();
        } catch (e) {
          console.error("Failed to send datagram", e);
        }
      }
      break;
  }
};
