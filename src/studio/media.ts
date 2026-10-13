/**
 * KLEO STUDIO — WHAT AN UPLOADED FILE IS. Pictures, video clips and audio clips arrive as raw bytes; the price of
 * many tools depends on how long a clip is (a talking photo is billed per second of voice, a video edit per second of
 * video), and the page's own claim about that length cannot be trusted with money. So the Worker reads it itself:
 *
 *   MP4 / MOV   the `mvhd` box (timescale, duration) and the first video `tkhd` (width, height)
 *   WAV         the `fmt ` byte rate and the `data` size
 *   MP3         the first frame header (bitrate, sample rate) and its Xing/Info frame count when the file is VBR
 *
 * No decoding, no dependency: a few hundred bytes of each file. Pure module, imported directly by the tests.
 */

export type MediaKind = "image" | "video" | "audio";
export interface MediaInfo { kind: MediaKind; type: string; ext: string; duration: number | null; width: number | null; height: number | null }

const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n));
const u32 = (b: Uint8Array, at: number): number => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
const u16le = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8);
const u32le = (b: Uint8Array, at: number): number => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) + b[at + 3] * 0x1000000;

/** What the bytes are, by their signature (never by the name or the declared type). */
export function sniffMedia(b: Uint8Array): Omit<MediaInfo, "duration" | "width" | "height"> | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: "image", type: "image/jpeg", ext: "jpg" };
  if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG") return { kind: "image", type: "image/png", ext: "png" };
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return { kind: "image", type: "image/webp", ext: "webp" };
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WAVE") return { kind: "audio", type: "audio/wav", ext: "wav" };
  if (ascii(b, 4, 4) === "ftyp") {
    const brand = ascii(b, 8, 4);
    if (/^(M4A |M4B )/.test(brand)) return { kind: "audio", type: "audio/mp4", ext: "m4a" };
    if (brand === "qt  ") return { kind: "video", type: "video/quicktime", ext: "mov" };
    return { kind: "video", type: "video/mp4", ext: "mp4" };
  }
  if (ascii(b, 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { kind: "audio", type: "audio/mpeg", ext: "mp3" };
  return null;
}

/** Walks ISO-BMFF boxes looking for `mvhd` and the first video `tkhd`. */
export function mp4Info(b: Uint8Array): { duration: number | null; width: number | null; height: number | null } {
  let duration: number | null = null, width: number | null = null, height: number | null = null;
  const walk = (start: number, end: number, depth: number): void => {
    let at = start;
    while (at + 8 <= end && depth < 8) {
      let size = u32(b, at);
      const type = ascii(b, at + 4, 4);
      let head = 8;
      if (size === 1) { size = u32(b, at + 8) * 0x100000000 + u32(b, at + 12); head = 16; }
      else if (size === 0) size = end - at;
      if (size < head || at + size > end) return;
      if (type === "moov" || type === "trak" || type === "mdia" || type === "minf") walk(at + head, at + size, depth + 1);
      else if (type === "mvhd" && duration === null) {
        const v = b[at + head];
        const timescale = v === 1 ? u32(b, at + head + 20) : u32(b, at + head + 12);
        const dur = v === 1 ? u32(b, at + head + 24) * 0x100000000 + u32(b, at + head + 28) : u32(b, at + head + 16);
        if (timescale > 0) duration = Math.round((dur / timescale) * 1000) / 1000;
      } else if (type === "tkhd" && width === null) {
        const v = b[at + head];
        const off = at + head + (v === 1 ? 88 : 76);
        const w = u32(b, off) / 65536, h = u32(b, off + 4) / 65536;
        if (w > 0 && h > 0) { width = Math.round(w); height = Math.round(h); }
      }
      at += size;
    }
  };
  walk(0, b.length, 0);
  return { duration, width, height };
}

export function wavDuration(b: Uint8Array): number | null {
  let at = 12, byteRate = 0;
  while (at + 8 <= b.length) {
    const id = ascii(b, at, 4), size = u32le(b, at + 4);
    if (id === "fmt ") byteRate = u32le(b, at + 16);
    if (id === "data") return byteRate > 0 ? Math.round(((Math.min(size, b.length - at - 8)) / byteRate) * 1000) / 1000 : null;
    at += 8 + size + (size % 2);
  }
  return null;
}

const MP3_KBPS: Record<number, number[]> = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // MPEG-1 layer III
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // MPEG-2/2.5 layer III
};
export function mp3Duration(b: Uint8Array): number | null {
  let at = 0;
  if (ascii(b, 0, 3) === "ID3") at = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f));
  for (; at + 4 < b.length; at++) {
    if (b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) continue;
    const ver = (b[at + 1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
    const layer = (b[at + 1] >> 1) & 3; // 1 = layer III
    const bi = b[at + 2] >> 4, si = (b[at + 2] >> 2) & 3;
    if (ver === 1 || layer !== 1 || bi === 0 || bi === 15 || si === 3) continue;
    const kbps = MP3_KBPS[ver === 3 ? 1 : 2][bi];
    const rate = [[11025, 12000, 8000], [0, 0, 0], [22050, 24000, 16000], [44100, 48000, 32000]][ver][si];
    const samples = ver === 3 ? 1152 : 576;
    // A VBR file says its frame count in a Xing/Info header inside the first frame.
    const mono = (b[at + 3] >> 6) === 3;
    const side = ver === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17);
    const x = at + 4 + side;
    const tag = ascii(b, x, 4);
    if ((tag === "Xing" || tag === "Info") && (b[x + 7] & 1)) return Math.round((u32(b, x + 8) * samples / rate) * 1000) / 1000;
    return Math.round(((b.length - at) * 8 / (kbps * 1000)) * 1000) / 1000;
  }
  return null;
}

/** Everything the Worker needs to know about an upload, or null when it is not a supported picture, clip or sound. */
export function mediaInfo(b: Uint8Array): MediaInfo | null {
  const s = sniffMedia(b);
  if (!s) return null;
  if (s.kind === "video") return { ...s, ...mp4Info(b) };
  if (s.type === "audio/wav") return { ...s, duration: wavDuration(b), width: null, height: null };
  if (s.type === "audio/mpeg") return { ...s, duration: mp3Duration(b), width: null, height: null };
  if (s.type === "audio/mp4") return { ...s, duration: mp4Info(b).duration, width: null, height: null };
  return { ...s, duration: null, width: null, height: null };
}

/** A minimal 16-bit PCM WAV header for `samples` samples (used by the tests and nothing else in production). */
export function wavHeader(sampleRate: number, samples: number): Uint8Array {
  const data = samples * 2, out = new Uint8Array(44);
  const w = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  const le = (at: number, v: number, n: number) => { for (let i = 0; i < n; i++) out[at + i] = (v >> (8 * i)) & 0xff; };
  w(0, "RIFF"); le(4, 36 + data, 4); w(8, "WAVE"); w(12, "fmt "); le(16, 16, 4); le(20, 1, 2); le(22, 1, 2);
  le(24, sampleRate, 4); le(28, sampleRate * 2, 4); le(32, 2, 2); le(34, 16, 2); w(36, "data"); le(40, data, 4);
  return out;
}
export const u16 = u16le;
