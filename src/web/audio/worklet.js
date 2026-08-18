/**
 * Taps raw microphone frames and forwards copies to the main thread.
 *
 * This exists because MediaRecorder cannot produce independently decodable
 * chunks: with a timeslice, only the first blob carries a container header and
 * the rest are fragments Groq rejects. Stopping and restarting the recorder per
 * chunk produces valid files but drops audio at every seam.
 */
class TapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      // The engine reuses this buffer, so copy before transferring.
      this.port.postMessage(new Float32Array(channel));
    }
    return true;
  }
}

registerProcessor("tap", TapProcessor);
