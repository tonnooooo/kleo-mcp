/**
 * KLEO STUDIO — WHAT AN UPLOADED FILE IS. Pictures, video clips and audio clips arrive as raw bytes; the price of
 * many tools depends on how long a clip is (a talking photo is billed per second of voice, a video edit per second of
 * video), and the page's own claim about that length cannot be trusted with money. So the Worker reads it itself:
 *
 *   MP4 / MOV   every place the file states its length — `mvhd`, each `tkhd` and `mdhd`, each track's sample table
 *               (`stts`, what a decoder actually plays) and edit list (`elst`) — and the LONGEST one counts; the size
 *               is the largest video track's (`tkhd`). A fragmented MP4 is flagged (its length lives in fragments).
 *               A length is timed once its timescale is known, wherever the box order puts it: a track's `stts` with
 *               that track's `mdhd`, the movie's claims with `mvhd`.
 *   WAV         every byte after the `data` header (not the size the header claims, which a streamed WAV leaves at
 *               0xFFFFFFFF), at the rate the samples imply (sample rate x frame size), never the header's own byte-rate
 *               field alone; a compressed WAV (ADPCM, MP3 inside) has no such rate and is not measured
 *   MP3         every frame header of the file, each its own samples at its own rate (layers I, II and III), never the
 *               Xing/Info frame count, and never less than the file's size played at 320 kbps
 *
 * WHY THE LONGEST (14 October 2026): the provider bills what it decodes, not what a header says, so a file with a short
 * `mvhd` over a long track was a way to buy a long edit at the price of a short one. The review's second pass (same day)
 * closed the three ways left: an `stts` placed before its track's `mdhd`, a WAV byte rate inflated tenfold, and an MP3
 * whose first frame (or Xing count) said 320 kbps over frames of 8.
 *
 * No decoding, no dependency: a few hundred bytes of each file. Pure module, imported directly by the tests.
 */

export type MediaKind = "image" | "video" | "audio";
export interface MediaInfo { kind: MediaKind; type: string; ext: string; duration: number | null; width: number | null; height: number | null; fragmented?: boolean }

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

const u64 = (b: Uint8Array, at: number): number => u32(b, at) * 0x100000000 + u32(b, at + 4);
/** A stated length worth believing: positive and under a day (0xFFFFFFFF and friends mean "unknown"). */
const plausible = (seconds: number): boolean => Number.isFinite(seconds) && seconds > 0 && seconds < 86_400;

/**
 * Walks ISO-BMFF boxes: the longest stated length, the largest video track, and whether the file is fragmented.
 * A length is timed only once the walk knows its timescale (14 October 2026): a track's `stts` sum waits for the end of
 * its `trak`, then takes that track's `mdhd` timescale (a demuxer builds its index after the whole track is read, so an
 * `mdhd` placed after `minf` still times the samples); `tkhd` and `elst` wait for the end of the file and take `mvhd`'s,
 * wherever `mvhd` sits. A track with no `mdhd` plays on the movie's timescale, as ffmpeg does. Where a file states two
 * timescales for one claim, each is tried and the longest result counts, like every other length here.
 */
export function mp4Info(b: Uint8Array): { duration: number | null; width: number | null; height: number | null; fragmented: boolean } {
  let width: number | null = null, height: number | null = null, fragmented = false;
  const lengths: number[] = [], movieScales: number[] = [], movieClaims: number[] = [];
  let trak: { scales: number[]; sums: number[] } | null = null;
  const keep = (dur: number, scale: number) => { if (scale > 0 && plausible(dur / scale)) lengths.push(dur / scale); };
  const walk = (start: number, end: number, depth: number): void => {
    let at = start;
    while (at + 8 <= end && depth < 10) {
      let size = u32(b, at);
      const type = ascii(b, at + 4, 4);
      let head = 8;
      if (size === 1) { size = u64(b, at + 8); head = 16; }
      else if (size === 0) size = end - at;
      if (size < head || at + size > end) return;
      const body = at + head, stop = at + size, v = b[body];
      if (type === "trak") {
        const outer = trak;
        const mine: { scales: number[]; sums: number[] } = { scales: [], sums: [] };
        trak = mine;
        walk(body, stop, depth + 1);
        trak = outer;
        if (mine.scales.length) { for (const sum of mine.sums) for (const scale of mine.scales) keep(sum, scale); }
        else movieClaims.push(...mine.sums);
      }
      else if (type === "moov" || type === "mdia" || type === "minf" || type === "stbl" || type === "edts") walk(body, stop, depth + 1);
      else if (type === "moof" || type === "mvex") fragmented = true;
      else if (type === "mvhd") {
        const scale = v === 1 ? u32(b, body + 20) : u32(b, body + 12);
        movieScales.push(scale);
        keep(v === 1 ? u64(b, body + 24) : u32(b, body + 16), scale);
      } else if (type === "tkhd") {
        movieClaims.push(v === 1 ? u64(b, body + 28) : u32(b, body + 20));
        const off = body + (v === 1 ? 88 : 76);
        const w = Math.round(u32(b, off) / 65536), h = Math.round(u32(b, off + 4) / 65536);
        if (w > 0 && h > 0 && w * h > (width ?? 0) * (height ?? 0)) { width = w; height = h; }
      } else if (type === "mdhd") {
        const scale = v === 1 ? u32(b, body + 20) : u32(b, body + 12);
        if (trak) trak.scales.push(scale);
        keep(v === 1 ? u64(b, body + 24) : u32(b, body + 16), scale);
      } else if (type === "stts") {
        let sum = 0;
        const n = u32(b, body + 4);
        for (let i = 0, e = body + 8; i < n && e + 8 <= stop; i++, e += 8) sum += u32(b, e) * u32(b, e + 4);
        if (trak) trak.sums.push(sum); else movieClaims.push(sum);
      } else if (type === "elst") {
        let sum = 0;
        const n = u32(b, body + 4), step = v === 1 ? 20 : 12;
        for (let i = 0, e = body + 8; i < n && e + step <= stop; i++, e += step) sum += v === 1 ? u64(b, e) : u32(b, e);
        movieClaims.push(sum);
      }
      at += size;
    }
  };
  walk(0, b.length, 0);
  for (const claim of movieClaims) for (const scale of movieScales) keep(claim, scale);
  const duration = lengths.length ? Math.round(Math.max(...lengths) * 1000) / 1000 : null;
  return { duration, width, height, fragmented };
}

/** The WAV formats whose every sample frame is the same size: PCM, IEEE float, A-law, mu-law, and the extensible header. */
const WAV_FRAMED = new Set([1, 3, 6, 7, 0xfffe]);
export function wavDuration(b: Uint8Array): number | null {
  let at = 12, rate = 0;
  while (at + 8 <= b.length) {
    const id = ascii(b, at, 4), size = u32le(b, at + 4);
    if (id === "fmt " && at + 24 <= b.length) {
      const format = u16le(b, at + 8), channels = u16le(b, at + 10), sampleRate = u32le(b, at + 12);
      const byteRate = u32le(b, at + 16), blockAlign = u16le(b, at + 20), bits = u16le(b, at + 22);
      // The bytes a second plays, from the samples themselves (14 October 2026): a decoder times PCM by sample rate
      // and frame size, not by the byte-rate field, so a field inflated tenfold read a long clip as a tenth of it. The
      // lowest of the three figures counts (the longest length); a compressed format has no fixed frame: rate 0.
      const figures = [byteRate, sampleRate * blockAlign, sampleRate * channels * Math.ceil(bits / 8)].filter((x) => x > 0);
      rate = WAV_FRAMED.has(format) && figures.length === 3 ? Math.min(...figures) : 0;
    }
    // Every byte after the header plays, and only those: the size the header claims is ignored either way, larger
    // (a streamed WAV writes 0xFFFFFFFF, it cannot seek back) or smaller (a player reads to the end of the file).
    if (id === "data") return rate > 0 ? Math.round(((b.length - at - 8) / rate) * 1000) / 1000 : null;
    at += 8 + size + (size % 2);
  }
  return null;
}

/** Bitrates (kbps) by MPEG version (1, or 2 for MPEG-2 and 2.5) and layer bits (3 = layer I, 2 = II, 1 = III). */
const MPEG_KBPS: Record<string, number[]> = {
  "1-3": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-1": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-3": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-1": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
/** Sample rates by version bits (0 = MPEG-2.5, 2 = MPEG-2, 3 = MPEG-1) and rate index. */
const MPEG_RATES: number[][] = [[11025, 12000, 8000], [0, 0, 0], [22050, 24000, 16000], [44100, 48000, 32000]];
/** One MPEG audio frame header at `at`: how many bytes the frame takes and how long it plays, or null when it is none. */
function mpegFrame(b: Uint8Array, at: number): { bytes: number; seconds: number } | null {
  if (at + 4 > b.length || b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) return null;
  const ver = (b[at + 1] >> 3) & 3, layer = (b[at + 1] >> 1) & 3;
  const bi = b[at + 2] >> 4, si = (b[at + 2] >> 2) & 3, pad = (b[at + 2] >> 1) & 1;
  if (ver === 1 || layer === 0 || bi === 0 || bi === 15 || si === 3) return null; // reserved values, or a free-format frame
  const kbps = MPEG_KBPS[`${ver === 3 ? 1 : 2}-${layer}`][bi], rate = MPEG_RATES[ver][si];
  const samples = layer === 3 ? 384 : layer === 2 || ver === 3 ? 1152 : 576;
  const bytes = layer === 3 ? (Math.floor((12 * kbps * 1000) / rate) + pad) * 4 : Math.floor(((samples / 8) * kbps * 1000) / rate) + pad;
  return { bytes, seconds: samples / rate };
}
/**
 * Every frame, each timed by its own header (14 October 2026): the Xing/Info count and the first frame's bitrate are
 * claims, and a file whose first frame said 320 kbps over frames of 8 (or whose Xing count said one frame) read as a
 * tenth of what a decoder plays. Between frames (tags, junk) the walk looks for the next header byte by byte, as a
 * decoder does. Never less than the file's size at 320 kbps. Fifteen megabytes are a few hundred thousand frames.
 */
export function mp3Duration(b: Uint8Array): number | null {
  let at = 0, seconds = 0, first = -1;
  if (ascii(b, 0, 3) === "ID3") at = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f));
  while (at + 4 <= b.length) {
    const f = mpegFrame(b, at);
    if (!f) { at++; continue; }
    if (first < 0) first = at;
    seconds += f.seconds;
    at += f.bytes;
  }
  if (first < 0) return null;
  const floor = ((b.length - first) * 8) / 320_000;
  return Math.round(Math.max(seconds, floor) * 1000) / 1000;
}

/** Everything the Worker needs to know about an upload, or null when it is not a supported picture, clip or sound. */
export function mediaInfo(b: Uint8Array): MediaInfo | null {
  const s = sniffMedia(b);
  if (!s) return null;
  if (s.kind === "video") { const m = mp4Info(b); return { ...s, duration: m.duration, width: m.width, height: m.height, fragmented: m.fragmented }; }
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
