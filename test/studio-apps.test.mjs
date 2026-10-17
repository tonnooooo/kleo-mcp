/**
 * Kleo Studio apps, the pure parts: reading clip lengths from bytes, presets, and the plan (provider calls + price)
 * of every app. Imports the TypeScript sources directly (Node 22.18+ strips the types).
 * Run: node --test test/studio-apps.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mediaInfo, mp4Info, mp3Duration, wavDuration, wavHeader } from "../src/studio/media.ts";
import { PRESETS, withPreset, publicPresets } from "../src/studio/presets.ts";
import { TOOLS, planTool, publicTools, toolCredits, scriptSeconds, ToolRefusal } from "../src/studio/tools.ts";
import { normalizeSettings, clipCredits, taskInput } from "../src/studio/models.ts";

/** A minimal MP4: ftyp + moov(mvhd, trak(tkhd)). */
export function fakeMp4(seconds, width = 1280, height = 720) {
  const box = (type, ...parts) => {
    const body = Buffer.concat(parts.map((p) => Buffer.from(p)));
    const head = Buffer.alloc(8); head.writeUInt32BE(8 + body.length); head.write(type, 4, "ascii");
    return Buffer.concat([head, body]);
  };
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(Math.round(seconds * 1000), 16);
  const tkhd = Buffer.alloc(84); tkhd.writeUInt32BE(width * 65536, 76); tkhd.writeUInt32BE(height * 65536, 80);
  const ftyp = box("ftyp", Buffer.from("isom"), Buffer.alloc(4), Buffer.from("isommp42"));
  return new Uint8Array(Buffer.concat([ftyp, box("moov", box("mvhd", mvhd), box("trak", box("tkhd", tkhd))), box("mdat", Buffer.alloc(500))]));
}
export function fakeWav(seconds, rate = 24000) {
  const samples = Math.round(seconds * rate);
  return new Uint8Array(Buffer.concat([Buffer.from(wavHeader(rate, samples)), Buffer.alloc(samples * 2)]));
}
/** `n` MPEG audio frames, each starting with `header` (4 bytes) and `bytes` long. */
function mpegFrames(n, header, bytes) {
  const frame = Buffer.alloc(bytes); Buffer.from(header).copy(frame);
  return Buffer.concat(Array.from({ length: n }, () => frame));
}
// MPEG-1 layer III, 128 kbps, 48 kHz: 384 bytes and 24 ms a frame.
const MP3_128 = [0xff, 0xfb, 0x94, 0x00];

test("media: kinds and lengths read from the bytes", () => {
  const mp4 = fakeMp4(8.5, 1920, 1080);
  assert.deepEqual(mp4Info(mp4), { duration: 8.5, width: 1920, height: 1080, fragmented: false });
  assert.equal(mediaInfo(mp4).kind, "video");
  assert.equal(mediaInfo(mp4).type, "video/mp4");
  const wav = fakeWav(2.5);
  assert.equal(wavDuration(wav), 2.5);
  assert.equal(mediaInfo(wav).kind, "audio");
  // 125 frames of MPEG-1 layer III at 128 kbps and 48 kHz: 125 x 24 ms = 3 s.
  const mp3 = new Uint8Array(mpegFrames(125, MP3_128, 384));
  assert.equal(mp3Duration(mp3), 3);
  assert.equal(mediaInfo(mp3).type, "audio/mpeg");
  const jpg = new Uint8Array(100); jpg.set([0xff, 0xd8, 0xff]);
  assert.equal(mediaInfo(jpg).kind, "image");
  assert.equal(mediaInfo(new Uint8Array(100).fill(7)), null);
});

test("media: a file cannot claim to be shorter than it plays (the longest stated length counts)", () => {
  const box = (type, ...parts) => {
    const body = Buffer.concat(parts.map((p) => Buffer.from(p)));
    const head = Buffer.alloc(8); head.writeUInt32BE(8 + body.length); head.write(type, 4, "ascii");
    return Buffer.concat([head, body]);
  };
  // mvhd says 2 s (timescale 1000); the video track's mdhd and its sample table say 30 s at 30 fps (timescale 30000).
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(2000, 16);
  const tkhd = Buffer.alloc(84); tkhd.writeUInt32BE(320 * 65536, 76); tkhd.writeUInt32BE(180 * 65536, 80);
  const tkhd2 = Buffer.alloc(84); tkhd2.writeUInt32BE(2560 * 65536, 76); tkhd2.writeUInt32BE(1440 * 65536, 80);
  const mdhd = Buffer.alloc(24); mdhd.writeUInt32BE(30000, 12); mdhd.writeUInt32BE(60000, 16); // also lies: 2 s
  const stts = Buffer.alloc(16); stts.writeUInt32BE(1, 4); stts.writeUInt32BE(900, 8); stts.writeUInt32BE(1000, 12); // 900 frames x 1/30 s
  const trak = (t) => box("trak", box("tkhd", t), box("mdia", box("mdhd", mdhd), box("minf", box("stbl", box("stts", stts)))));
  const ftyp = box("ftyp", Buffer.from("isom"), Buffer.alloc(4), Buffer.from("isommp42"));
  const lying = new Uint8Array(Buffer.concat([ftyp, box("moov", box("mvhd", mvhd), trak(tkhd), trak(tkhd2)), box("mdat", Buffer.alloc(64))]));
  const info = mp4Info(lying);
  assert.equal(info.duration, 30, "900 samples of 1/30 s play for 30 s, whatever mvhd and mdhd say");
  assert.deepEqual([info.width, info.height], [2560, 1440], "the largest track decides the size");
  // A fragmented MP4 keeps its length in fragments: flagged, so the upload refuses it.
  const frag = new Uint8Array(Buffer.concat([ftyp, box("moov", box("mvhd", mvhd), box("mvex")), box("moof"), box("mdat", Buffer.alloc(64))]));
  assert.equal(mp4Info(frag).fragmented, true);
  // WAV: the bytes after the header play, whatever size the header claims.
  const wav = fakeWav(3); new DataView(wav.buffer).setUint32(40, 2 * 24000, true); // header says 1 s of data
  assert.equal(wavDuration(wav), 3);
  // MP3: a Xing frame count of 1 frame on a 160 000-byte file is refused: at 320 kbps those bytes are 4 s.
  const mp3 = new Uint8Array(160000); mp3.set([0xff, 0xfb, 0x90, 0x00]);
  const x = 4 + 32; mp3.set([0x58, 0x69, 0x6e, 0x67, 0, 0, 0, 1, 0, 0, 0, 1], x);
  assert.equal(mp3Duration(mp3), 4);
});

test("media: the second pass (14 October 2026) - box order, a streamed or inflated WAV header, an MP3 that changes bitrate", () => {
  const box = (type, ...parts) => {
    const body = Buffer.concat(parts.map((p) => Buffer.from(p)));
    const head = Buffer.alloc(8); head.writeUInt32BE(8 + body.length); head.write(type, 4, "ascii");
    return Buffer.concat([head, body]);
  };
  const ftyp = box("ftyp", Buffer.from("isom"), Buffer.alloc(4), Buffer.from("isommp42"));
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(2000, 16); // 2 s
  const tkhd = Buffer.alloc(84); tkhd.writeUInt32BE(640 * 65536, 76); tkhd.writeUInt32BE(360 * 65536, 80);
  const mdhd = Buffer.alloc(24); mdhd.writeUInt32BE(30000, 12); mdhd.writeUInt32BE(60000, 16); // 2 s
  const stts = Buffer.alloc(16); stts.writeUInt32BE(1, 4); stts.writeUInt32BE(900, 8); stts.writeUInt32BE(1000, 12); // 30 s at 1/30 s
  // MP4: the sample table placed BEFORE its track's mdhd still counts (it was dropped as untimed).
  const late = box("trak", box("tkhd", tkhd), box("mdia", box("minf", box("stbl", box("stts", stts))), box("mdhd", mdhd)));
  assert.equal(mp4Info(new Uint8Array(Buffer.concat([ftyp, box("moov", box("mvhd", mvhd), late), box("mdat", Buffer.alloc(64))]))).duration, 30);
  // MP4: a track header placed before mvhd is timed by mvhd all the same (30 000 ticks of 1/1000 s).
  const tkhd30 = Buffer.from(tkhd); tkhd30.writeUInt32BE(30000, 20);
  assert.equal(mp4Info(new Uint8Array(Buffer.concat([ftyp, box("moov", box("trak", box("tkhd", tkhd30)), box("mvhd", mvhd)), box("mdat", Buffer.alloc(64))]))).duration, 30);
  // No timescale anywhere: no length to trust, so none (the apps refuse the clip).
  assert.equal(mp4Info(new Uint8Array(Buffer.concat([ftyp, box("moov", box("trak", box("tkhd", tkhd30))), box("mdat", Buffer.alloc(64))]))).duration, null);

  // WAV: a streamed header (data size 0xFFFFFFFF, its writer could not seek back) is measured by its bytes, not 25 hours.
  const streamed = fakeWav(3); new DataView(streamed.buffer).setUint32(40, 0xffffffff, true);
  assert.equal(wavDuration(streamed), 3);
  // WAV: a byte-rate field inflated tenfold does not shorten the clip: the samples' own rate counts.
  const inflated = fakeWav(3); new DataView(inflated.buffer).setUint32(28, 24000 * 2 * 10, true);
  assert.equal(wavDuration(inflated), 3);
  // WAV: a compressed format (2 = MS ADPCM) has no fixed frame size: not measured.
  const adpcm = fakeWav(3); new DataView(adpcm.buffer).setUint16(20, 2, true);
  assert.equal(wavDuration(adpcm), null);

  // MP3: a first frame at 320 kbps with a Xing count of ONE frame, then 1000 frames of MPEG-2 layer III at 8 kbps and
  // 24 kHz (24 bytes, 24 ms each). The old reading (the Xing count, or the file at 320 kbps) said 0.624 s; it plays 24 s.
  const head = Buffer.alloc(960); Buffer.from([0xff, 0xfb, 0xe4, 0x00]).copy(head); // MPEG-1 III, 320 kbps, 48 kHz
  Buffer.from([0x58, 0x69, 0x6e, 0x67, 0, 0, 0, 1, 0, 0, 0, 1]).copy(head, 4 + 32);
  const slow = new Uint8Array(Buffer.concat([head, mpegFrames(1000, [0xff, 0xf3, 0x14, 0x00], 24)]));
  assert.equal(mp3Duration(slow), 24.024);
  // MP3: no Xing, the first frame at 128 kbps, the rest at 8 kbps: every frame is timed by its own header.
  const mixed = new Uint8Array(Buffer.concat([mpegFrames(1, MP3_128, 384), mpegFrames(500, [0xff, 0xf3, 0x14, 0x00], 24)]));
  assert.equal(mp3Duration(mixed), 12.024);
  // MP3: an ID3 tag in front is skipped, and frames of layer II count like the others (1152 samples, 48 kHz: 24 ms).
  const id3 = Buffer.alloc(10 + 100); id3.write("ID3", 0); id3[9] = 100;
  const layer2 = mpegFrames(50, [0xff, 0xfd, 0x84, 0x00], 384); // MPEG-1 layer II, 128 kbps (index 8 in its table), 48 kHz
  assert.equal(mp3Duration(new Uint8Array(Buffer.concat([id3, layer2]))), 1.2);
});

test("presets: added once, published without their prompt text", () => {
  assert.ok(PRESETS.length >= 20);
  assert.equal(new Set(PRESETS.map((p) => p.key)).size, PRESETS.length);
  const once = withPreset("a cat on a roof", "orbit-360");
  assert.match(once, /360-degree orbit/);
  assert.equal(withPreset(once, "orbit-360"), once);
  assert.equal(withPreset("x", "nope"), "x");
  assert.ok(!("text" in publicPresets()[0]));
});

test("video with clips: Veo switches to Seedance, reference seconds are billed, edit/extend need 2.5", () => {
  const refs = { images: 1, videos: 1, audios: 0, videoSeconds: 8 };
  const s = normalizeSettings({ model: "veo-3.1", duration: 5 }, 1, refs);
  assert.equal(s.model, "seedance-2.5");
  assert.equal(s.imageRole, "reference");
  assert.equal(s.videoRole, "reference");
  // max(9, 8 + 5) = 13 s at 0.91 ¥ × 0.9 / 7 = 1.521 $ → ×1.6/0.44 = 5.53 → 6 credits
  assert.equal(clipCredits(s, 1.6, 8), 6);
  const fast = normalizeSettings({ model: "seedance-2.0-fast", videoRole: "extend" }, 0, { images: 0, videos: 1, audios: 0, videoSeconds: 4 });
  assert.equal(fast.model, "seedance-2.5", "extend is a 2.5 feature");
  const input = taskInput(fast, "keep going", [], undefined, { videos: ["https://x/v.mp4"], audios: [] });
  assert.deepEqual({ t: input.omni_reference_task_type, a: input.aspect_ratio, v: input.reference_videos }, { t: "extend", a: "adaptive", v: ["https://x/v.mp4"] });
  const edit = taskInput(normalizeSettings({ model: "seedance-2.5", videoRole: "edit" }, 0, { images: 0, videos: 1, audios: 0, videoSeconds: 6 }), "make it snow", [], undefined, { videos: ["v"], audios: [] });
  assert.equal(edit.duration, -1);
  const voiceOnly = normalizeSettings({ model: "seedance-2.0" }, 0, { images: 0, videos: 0, audios: 1, videoSeconds: 0 });
  assert.equal(voiceOnly.model, "seedance-2.5", "a sound clip alone is a 2.5 feature");
});

const img = (id, w = 1024, h = 1536) => ({ id, url: `https://k/${id}`, kind: "image", seconds: null, width: w, height: h, type: "image/jpeg" });
const vid = (id, s, w = 1280, h = 720) => ({ id, url: `https://k/${id}`, kind: "video", seconds: s, width: w, height: h, type: "video/mp4" });
const aud = (id, s) => ({ id, url: `https://k/${id}`, kind: "audio", seconds: s, width: null, height: null, type: "audio/wav" });

test("apps: every app plans, prices within reason and refuses what it cannot do", () => {
  const face = planTool("face-swap", {}, { target: img("t"), face: img("f", 800, 800) });
  assert.equal(face.tasks[0].model, "gemini-3-pro-image");
  assert.deepEqual(face.tasks[0].input.images, ["https://k/t", "https://k/f"]);
  assert.equal(face.tasks[0].input.aspect_ratio, "2:3");
  assert.equal(toolCredits(face.usd), 1);
  assert.throws(() => planTool("face-swap", {}, { target: img("t") }), ToolRefusal);
  assert.throws(() => planTool("face-swap", {}, { target: vid("t", 5), face: img("f") }), /must be a picture/);

  const vfs = planTool("video-face-swap", {}, { video: vid("v", 10), face: img("f") });
  assert.equal(vfs.tasks[0].model, "happyhorse-1.0-video-edit");
  assert.equal(vfs.tasks[0].input.watermark, false);
  assert.equal(toolCredits(vfs.usd), 8, "20 billed seconds at ¥0.72/s");
  assert.throws(() => planTool("video-face-swap", {}, { video: vid("v", 40), face: img("f") }), /too long/);

  const talk = planTool("talking-photo", { script: "Hello there, welcome to my channel!", voice: "nova" }, { image: img("p") });
  assert.equal(talk.speech.voice, "nova");
  assert.equal(talk.tasks[0].input.sound_file, "{{speech}}");
  assert.equal(talk.tasks[0].model, "kling_avatar_image2video");
  const talkAudio = planTool("talking-photo", { source: "audio", quality: "pro" }, { image: img("p"), audio: aud("a", 20) });
  assert.equal(talkAudio.tasks[0].input.mode, "pro");
  assert.equal(talkAudio.tasks[0].input.sound_file, "https://k/a");
  assert.equal(toolCredits(talkAudio.usd), 7, "20 s pro: 16 Kling credits");
  assert.throws(() => planTool("talking-photo", { source: "audio" }, { image: img("p"), audio: aud("a", 90) }), /too long/);

  const lip = planTool("lipsync", { source: "audio" }, { video: vid("v", 10), audio: aud("a", 8) });
  assert.equal(lip.tasks[0].input.original_audio_volume, 0);
  assert.equal(toolCredits(lip.usd), 1);

  // Character Swap (18 Oct 2026): Kling O1 edits the video itself; 3-10 s, the base video 700-2160 px tall.
  const swap = planTool("character-swap", { prompt: "keep the red jacket" }, { video: vid("v", 4), image: img("c") });
  assert.equal(swap.tasks[0].model, "kling-o1/omni-video");
  assert.deepEqual(swap.tasks[0].input.contents.map((c) => c.type), ["prompt", "base_video", "refer_image"]);
  assert.match(swap.tasks[0].input.contents[0].text, /Replace the main person in the video with the character from the reference image.*keep the red jacket$/);
  assert.deepEqual(swap.tasks[0].input.settings, { resolution: "720p", duration: 4, audio: "original", aspect_ratio: "16:9" });
  assert.equal(toolCredits(swap.usd), 2, "4 s at 0.9 Kling credits a second (about $0.41, measured)");
  assert.equal(planTool("character-swap", {}, { video: vid("v", 6, 1080, 1920), image: img("c") }).tasks[0].input.settings.aspect_ratio, "9:16");
  assert.throws(() => planTool("character-swap", {}, { video: vid("v", 4, 854, 480), image: img("c") }), /at least 700 pixels tall/);
  assert.throws(() => planTool("character-swap", {}, { video: vid("v", 14), image: img("c") }), /too long/);
  const motion = planTool("motion-control", { prompt: "on a neon stage", quality: "1080p" }, { image: img("c"), video: vid("m", 10) });
  assert.equal(motion.tasks[0].model, "kling-3.0/motion-control");
  assert.deepEqual(motion.tasks[0].input.contents.map((c) => c.type), ["prompt", "image", "video"]);
  assert.equal(motion.tasks[0].input.settings.resolution, "1080p");

  const up = planTool("video-upscale", {}, { video: vid("v", 10, 1280, 720) });
  assert.equal(up.tasks[0].input.upscale_factor, 3);
  assert.throws(() => planTool("video-upscale", {}, { video: vid("v", 10, 3840, 2160) }), /already very sharp/);

  assert.equal(planTool("voice", { script: "Hi!", voice: "onyx", tone: "calm" }, {}).tasks.length, 0);
  const music = planTool("music", { prompt: "lofi beats for studying", vocals: "female" }, {});
  assert.deepEqual({ i: music.tasks[0].input.instrumental, g: music.tasks[0].input.vocal_gender }, { i: false, g: "Female" });
  assert.equal(planTool("sfx", { prompt: "rain on a tin roof", loop: "loop" }, {}).tasks[0].input.type, "loop");
  assert.equal(planTool("outfit-swap", {}, { person: img("p"), garment: img("g") }).tasks[0].model, "flux-tools/vto-v1");
  assert.throws(() => planTool("video-edit", { prompt: "" }, { video: vid("v", 5) }), /Say what should change/);

  assert.equal(scriptSeconds("x".repeat(120)), 10);
  // Every app in the catalog has a plan, and every face app asks for consent.
  for (const t of TOOLS) assert.ok(typeof t.name === "string" && t.fields.length > 0, t.key);
  for (const t of TOOLS.filter((x) => x.group === "face")) assert.equal(t.consent, true, t.key);
  for (const t of publicTools()) assert.ok(t.from >= 1, t.key);
});
