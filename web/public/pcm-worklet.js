// Mic capture: resamples to 24 kHz mono and posts Int16 PCM chunks of ~100 ms,
// plus the chunk's RMS level for the UI meter.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 24000;
    this.pos = 0;
    this.buf = new Int16Array(2400);
    this.n = 0;
    this.sq = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // Linear-interpolated decimation; pos is the fractional read position in ch.
    while (this.pos < ch.length) {
      const i = Math.floor(this.pos);
      const f = this.pos - i;
      const v = i + 1 < ch.length ? ch[i] + (ch[i + 1] - ch[i]) * f : ch[i];
      this.sq += v * v;
      this.buf[this.n++] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
      if (this.n === this.buf.length) {
        this.port.postMessage({ pcm: this.buf.buffer, level: Math.sqrt(this.sq / this.n) }, [this.buf.buffer]);
        this.buf = new Int16Array(2400);
        this.n = 0;
        this.sq = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= ch.length;
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
