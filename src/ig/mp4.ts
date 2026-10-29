/**
 * KLEO INSTAGRAM PUBLISHER — WHAT IS INSIDE THE REEL'S FILE (29 October 2026).
 *
 * Reads an MP4 or MOV through ranged reads (R2 in the Worker, the file on disk in scripts/ig-schedule.mjs): the
 * top-level boxes, then the moov box alone (a few hundred kB), never the picture. Then compares it with Meta's
 * "Reel Specifications" (IG User Media reference, read 29 Oct 2026) and with the owner's Instagram file (1080x1920,
 * 30 fps, H.264 High, about 15 Mb/s):
 *   MOV or MP4, moov at the front, no edit lists; H.264 or HEVC, 4:2:0; 23-60 fps; at most 1920 columns; aspect ratio
 *   0.01:1 to 10:1; at most 25 Mb/s; AAC, at most 48 kHz, mono or stereo, 128 kb/s; 3 s to 15 min; at most 300 MB.
 * A file Meta would refuse is an error (the container would come back ERROR at the publish time); a file that only
 * falls short of the owner's quality is a warning.
 */

export type ReadAt = (offset: number, length: number) => Promise<Uint8Array>;

export interface Track {
  codec: string;
  width: number;
  height: number;
  fps: number | null;
  kbps: number | null;
  sampleRate: number | null;
  channels: number | null;
  /** H.264 profile_idc (100 = High) or HEVC general_profile_idc. */
  profile: number | null;
  /** chroma_format_idc: 1 = 4:2:0. */
  chroma: number | null;
  /** An edit list that does more than show the whole track from its start. */
  editList: boolean;
}

export interface Mp4Info {
  size: number;
  /** The top-level boxes in file order, up to the first moov and mdat. */
  boxes: string[];
  faststart: boolean;
  durationS: number | null;
  video: Track | null;
  audio: Track | null;
  /** Why the file could not be read at all, or null. */
  problem: string | null;
}

export const MAX_BYTES = 300 * 1024 * 1024;
const MAX_MOOV = 32 * 1024 * 1024;

interface Box { type: string; at: number; body: number; end: number }

const fourcc = (dv: DataView, at: number): string =>
  String.fromCharCode(dv.getUint8(at), dv.getUint8(at + 1), dv.getUint8(at + 2), dv.getUint8(at + 3));

function children(dv: DataView, start: number, end: number): Box[] {
  const out: Box[] = [];
  for (let at = start; at + 8 <= end && out.length < 1024;) {
    let len = dv.getUint32(at), body = at + 8;
    if (len === 1) {
      if (at + 16 > end) break;
      len = Number(dv.getBigUint64(at + 8));
      body = at + 16;
    } else if (len === 0) len = end - at;
    if (len < body - at || at + len > end) break;
    out.push({ type: fourcc(dv, at + 4), at, body, end: at + len });
    at += len;
  }
  return out;
}
const child = (dv: DataView, b: Box | undefined, type: string): Box | undefined =>
  b ? children(dv, b.body, b.end).find((c) => c.type === type) : undefined;
const path = (dv: DataView, b: Box | undefined, ...types: string[]): Box | undefined =>
  types.reduce<Box | undefined>((acc, t) => child(dv, acc, t), b);

/** Version 1 boxes carry 64-bit times: [timescale, duration]. */
function timescaleDuration(dv: DataView, b: Box): [number, number] {
  return dv.getUint8(b.body) === 1
    ? [dv.getUint32(b.body + 20), Number(dv.getBigUint64(b.body + 24))]
    : [dv.getUint32(b.body + 12), dv.getUint32(b.body + 16)];
}

/**
 * chroma_format_idc of an H.264 track: the avcC extension after the parameter sets (ISO/IEC 14496-15, written for the
 * High profiles), else what the profile allows: Baseline, Main, Extended, High and High 10 are 4:2:0 only.
 */
function avcChroma(dv: DataView, avcC: Box, profile: number): number | null {
  let at = avcC.body + 5;
  const sps = dv.getUint8(at++) & 0x1f;
  for (let i = 0; i < sps && at + 2 <= avcC.end; i++) at += 2 + dv.getUint16(at);
  if (at < avcC.end) {
    const pps = dv.getUint8(at++);
    for (let i = 0; i < pps && at + 2 <= avcC.end; i++) at += 2 + dv.getUint16(at);
    if ([100, 110, 122, 144].includes(profile) && at < avcC.end) return dv.getUint8(at) & 0x03;
  }
  return [66, 77, 88, 100, 110].includes(profile) ? 1 : null;
}

function readTrack(dv: DataView, trak: Box): { kind: string; track: Track; seconds: number | null } | null {
  const mdia = child(dv, trak, "mdia"), hdlr = child(dv, mdia, "hdlr"), mdhd = child(dv, mdia, "mdhd");
  const stbl = path(dv, mdia, "minf", "stbl"), stsd = child(dv, stbl, "stsd");
  if (!hdlr || !mdhd || !stsd || stsd.body + 16 > stsd.end) return null;
  const kind = fourcc(dv, hdlr.body + 8);
  const [timescale, duration] = timescaleDuration(dv, mdhd);
  const seconds = timescale > 0 && duration > 0 ? duration / timescale : null;
  const entry = children(dv, stsd.body + 8, stsd.end)[0];
  if (!entry) return null;
  const track: Track = { codec: entry.type, width: 0, height: 0, fps: null, kbps: null, sampleRate: null, channels: null, profile: null, chroma: null, editList: false };

  if (kind === "vide" && entry.body + 78 <= entry.end) {
    track.width = dv.getUint16(entry.body + 24);
    track.height = dv.getUint16(entry.body + 26);
    const config = children(dv, entry.body + 78, entry.end);
    const avcC = config.find((c) => c.type === "avcC"), hvcC = config.find((c) => c.type === "hvcC");
    if (avcC && avcC.body + 6 <= avcC.end) {
      track.profile = dv.getUint8(avcC.body + 1);
      track.chroma = avcChroma(dv, avcC, track.profile);
    } else if (hvcC && hvcC.body + 17 <= hvcC.end) {
      track.profile = dv.getUint8(hvcC.body + 1) & 0x1f;
      track.chroma = dv.getUint8(hvcC.body + 16) & 0x03;
    }
  } else if (kind === "soun" && entry.body + 28 <= entry.end) {
    const version = dv.getUint16(entry.body + 8);
    if (version === 2 && entry.body + 48 <= entry.end) {
      track.sampleRate = Math.round(dv.getFloat64(entry.body + 32));
      track.channels = dv.getUint32(entry.body + 40);
    } else {
      track.channels = dv.getUint16(entry.body + 16);
      track.sampleRate = dv.getUint32(entry.body + 24) >>> 16;
    }
  }

  // The size the picture is shown at: the track header's, turned when its matrix says 90 or 270 degrees.
  const tkhd = child(dv, trak, "tkhd");
  if (kind === "vide" && tkhd) {
    const m = tkhd.body + (dv.getUint8(tkhd.body) === 1 ? 52 : 40);
    if (m + 44 <= tkhd.end) {
      const w = dv.getUint32(m + 36) >>> 16, h = dv.getUint32(m + 40) >>> 16;
      const a = dv.getInt32(m), d = dv.getInt32(m + 16);
      const turned = a === 0 && d === 0;
      if (w && h) { track.width = turned ? h : w; track.height = turned ? w : h; }
      else if (turned) [track.width, track.height] = [track.height, track.width];
    }
  }

  const stts = child(dv, stbl, "stts");
  if (stts && kind === "vide" && timescale > 0) {
    const n = Math.min(dv.getUint32(stts.body + 4), Math.floor((stts.end - stts.body - 8) / 8));
    let samples = 0, ticks = 0;
    for (let i = 0; i < n; i++) {
      const count = dv.getUint32(stts.body + 8 + i * 8), delta = dv.getUint32(stts.body + 12 + i * 8);
      samples += count; ticks += count * delta;
    }
    if (samples > 0 && ticks > 0) track.fps = Math.round((samples / (ticks / timescale)) * 100) / 100;
  }

  const stsz = child(dv, stbl, "stsz");
  if (stsz && seconds && stsz.body + 12 <= stsz.end) {
    const size = dv.getUint32(stsz.body + 4), count = dv.getUint32(stsz.body + 8);
    let bytes = size * count;
    if (size === 0) {
      bytes = 0;
      const n = Math.min(count, Math.floor((stsz.end - stsz.body - 12) / 4));
      for (let i = 0; i < n; i++) bytes += dv.getUint32(stsz.body + 12 + i * 4);
    }
    track.kbps = Math.round((bytes * 8) / seconds / 1000);
  }

  const elst = path(dv, trak, "edts", "elst");
  if (elst && elst.body + 8 <= elst.end) {
    const v1 = dv.getUint8(elst.body) === 1, entries = dv.getUint32(elst.body + 4);
    const mediaTime = entries >= 1 && elst.body + (v1 ? 24 : 16) <= elst.end
      ? (v1 ? Number(dv.getBigInt64(elst.body + 16)) : dv.getInt32(elst.body + 12)) : 0;
    track.editList = entries > 1 || mediaTime !== 0;
  }
  return { kind, track, seconds };
}

/** The file's boxes and tracks. Never throws on a broken file: `problem` says what is wrong. */
export async function inspectMp4(size: number, readAt: ReadAt): Promise<Mp4Info> {
  const info: Mp4Info = { size, boxes: [], faststart: false, durationS: null, video: null, audio: null, problem: null };
  let moov: { at: number; len: number } | null = null, mdat = -1;
  for (let at = 0, n = 0; at + 8 <= size && n < 64 && !(moov && mdat >= 0); n++) {
    const h = await readAt(at, Math.min(16, size - at));
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let len = dv.getUint32(0);
    const type = fourcc(dv, 4);
    if (len === 1) len = h.byteLength >= 16 ? Number(dv.getBigUint64(8)) : 0;
    else if (len === 0) len = size - at;
    if (len < 8 || at + len > size) { info.problem = `The file is cut short or broken at byte ${at} (box "${type}").`; break; }
    info.boxes.push(type);
    if (type === "moov") moov = { at, len };
    if (type === "mdat" && mdat < 0) mdat = at;
    at += len;
  }
  if (!moov) { info.problem ??= "No moov box: this is not a playable MP4."; return info; }
  info.faststart = mdat < 0 || moov.at < mdat;
  if (moov.len > MAX_MOOV) { info.problem = `The moov box is ${Math.round(moov.len / 1048576)} MB: not a reel.`; return info; }
  const bytes = await readAt(moov.at, moov.len);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = children(dv, 0, bytes.byteLength)[0];
  if (!top || top.type !== "moov") { info.problem = "The moov box could not be read."; return info; }
  const mvhd = child(dv, top, "mvhd");
  if (mvhd) {
    const [timescale, duration] = timescaleDuration(dv, mvhd);
    if (timescale > 0 && duration > 0) info.durationS = Math.round((duration / timescale) * 100) / 100;
  }
  for (const trak of children(dv, top.body, top.end).filter((b) => b.type === "trak")) {
    let t: ReturnType<typeof readTrack> = null;
    try { t = readTrack(dv, trak); } catch { t = null; }
    if (!t) continue;
    if (t.kind === "vide" && !info.video) info.video = t.track;
    if (t.kind === "soun" && !info.audio) info.audio = t.track;
    if (info.durationS === null && t.seconds) info.durationS = Math.round(t.seconds * 100) / 100;
  }
  return info;
}

const VIDEO_CODECS: Record<string, string> = { avc1: "H.264", avc3: "H.264", hvc1: "HEVC", hev1: "HEVC" };

/** "1080x1920 H.264 30 fps 15.2 Mb/s · AAC 48 kHz stereo 320 kb/s · 14.0 s · 27.1 MB · moov at the front" */
export function mp4Summary(info: Mp4Info): string {
  const parts: string[] = [];
  const v = info.video, a = info.audio;
  if (v) parts.push(`${v.width}x${v.height} ${VIDEO_CODECS[v.codec] ?? v.codec}${v.fps ? ` ${v.fps} fps` : ""}${v.kbps ? ` ${(v.kbps / 1000).toFixed(1)} Mb/s` : ""}`);
  if (a) parts.push(`${a.codec === "mp4a" ? "AAC" : a.codec}${a.sampleRate ? ` ${a.sampleRate / 1000} kHz` : ""}${a.channels ? ` ${a.channels === 2 ? "stereo" : a.channels === 1 ? "mono" : `${a.channels} ch`}` : ""}${a.kbps ? ` ${a.kbps} kb/s` : ""}`);
  else parts.push("no sound");
  if (info.durationS) parts.push(`${info.durationS.toFixed(1)} s`);
  parts.push(`${(info.size / 1048576).toFixed(1)} MB`);
  parts.push(info.faststart ? "moov at the front" : "moov at the end");
  return parts.join(" · ");
}

/** Meta's Reels specification (errors) and the owner's Instagram file (warnings). */
export function specProblems(info: Mp4Info): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  if (info.problem) return { errors: [info.problem], warnings };
  if (info.size > MAX_BYTES) errors.push(`The file is ${(info.size / 1048576).toFixed(0)} MB; Meta takes at most 300 MB.`);
  if (!info.faststart) errors.push("The moov box is after the picture data; Meta wants it at the front. Re-mux with ffmpeg -c copy -movflags +faststart.");
  const v = info.video, a = info.audio;
  if (!v) return { errors: [...errors, "The file has no video track."], warnings };
  if (!VIDEO_CODECS[v.codec]) errors.push(`The video is "${v.codec}"; Meta takes H.264 or HEVC.`);
  if (v.chroma !== null && v.chroma !== 1) errors.push("The video is not 4:2:0; Meta wants 4:2:0 (ffmpeg -pix_fmt yuv420p).");
  if (v.codec.startsWith("avc") && v.profile === 110) warnings.push("The video is 10-bit H.264 (High 10); 8-bit is the safe choice (-pix_fmt yuv420p).");
  if (v.width > 1920) errors.push(`The video is ${v.width} pixels wide; Meta takes at most 1920 columns.`);
  if (v.width && v.height) {
    const r = v.width / v.height;
    if (r < 0.01 || r > 10) errors.push(`The aspect ratio ${v.width}:${v.height} is outside 0.01:1-10:1.`);
    if (v.width !== 1080 || v.height !== 1920) warnings.push(`The video is ${v.width}x${v.height}; the owner's Instagram file is 1080x1920 (ACCOUNT_RULES 9).`);
  }
  if (v.fps !== null) {
    if (v.fps < 23 || v.fps > 60) errors.push(`The video runs at ${v.fps} fps; Meta takes 23 to 60.`);
    else if (v.fps > 30.5) warnings.push(`The video runs at ${v.fps} fps; Instagram plays reels at 30 (take every second frame of a 60 fps master).`);
  }
  if (v.kbps !== null && v.kbps > 25_000) errors.push(`The video is ${(v.kbps / 1000).toFixed(1)} Mb/s; Meta takes at most 25.`);
  if (v.editList) warnings.push("The video track has an edit list; Meta's specification says none. If Instagram refuses the file, re-mux with ffmpeg -use_editlist 0 -movflags +faststart.");
  if (info.durationS !== null) {
    if (info.durationS < 3) errors.push(`The reel is ${info.durationS} s; Meta takes at least 3 s.`);
    if (info.durationS > 900) errors.push(`The reel is ${Math.round(info.durationS / 60)} min; Meta takes at most 15.`);
  }
  if (!a) warnings.push("The reel has no sound; a song cannot be added through the API (only in the app).");
  else {
    if (a.codec !== "mp4a") errors.push(`The sound is "${a.codec}"; Meta takes AAC.`);
    if (a.sampleRate !== null && a.sampleRate > 48_000) errors.push(`The sound is ${a.sampleRate / 1000} kHz; Meta takes at most 48 kHz.`);
    if (a.channels !== null && a.channels !== 1 && a.channels !== 2) errors.push(`The sound has ${a.channels} channels; Meta takes mono or stereo.`);
    if (a.kbps !== null && a.kbps > 140) warnings.push(`The sound is ${a.kbps} kb/s; Meta's specification says 128 kb/s (Instagram re-encodes it anyway).`);
  }
  return { errors, warnings };
}
