/**
 * Every chunk recorder.js writes is a self-contained 16 kHz mono 16-bit PCM
 * WAV file with its own 44-byte header. Joining them for a whole-session or
 * single-chunk read means keeping exactly one header and concatenating the
 * `data` payloads: playing back N headers back to back would make N
 * audible clicks, one per chunk boundary, since a browser's <audio> element
 * treats a second RIFF chunk mid-stream as garbage rather than as more data.
 */

const HEADER_BYTES = 44;

class WavFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WavFormatError";
  }
}

export function joinWavs(buffers: Buffer[]): Buffer {
  const payloads = buffers.map((buffer) => {
    if (buffer.length < HEADER_BYTES) {
      throw new WavFormatError(
        `WAV buffer is only ${buffer.length} bytes, shorter than the 44-byte header`,
      );
    }
    // Trust the `data` chunk's own declared size over the buffer's length:
    // a chunk file can carry trailing padding, but never trailing audio.
    const dataLength = buffer.readUInt32LE(40);
    return buffer.subarray(HEADER_BYTES, HEADER_BYTES + dataLength);
  });

  const dataLength = payloads.reduce((sum, payload) => sum + payload.length, 0);

  const header = Buffer.alloc(HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(16000, 24); // sample rate
  header.writeUInt32LE(32000, 28); // byte rate: 16000 Hz * 1 channel * 2 bytes
  header.writeUInt16LE(2, 32); // block align: 1 channel * 2 bytes
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataLength, 40);

  return Buffer.concat([header, ...payloads]);
}
