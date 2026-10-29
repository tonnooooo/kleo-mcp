/**
 * kleo-watermark — burns the Kleo mark into the clips of Studio accounts that never paid (src/studio/watermark.ts).
 *
 * Reachable only through kleo-studio's WATERMARK service binding: no route, no workers.dev address.
 *   POST /mark   an MP4 in, the same MP4 with "Made with Kleo" out (server.py inside the Container does the work)
 *
 * Each request goes to one of MAX_BOXES Containers (instance type "basic": 1/4 vCPU, 1 GiB), which sleep after
 * two quiet minutes. Cost and measurements: README.md.
 */
import { Container, getRandom } from "@cloudflare/containers";

export class Marker extends Container {
  defaultPort = 8080;
  sleepAfter = "2m";
  // ffmpeg needs nothing from the internet: the clip comes in the request, the mark is in the image.
  enableInternet = false;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/mark") return new Response("Not found", { status: 404 });
    const box = await getRandom(env.MARKER, Number(env.MAX_BOXES ?? 3));
    return box.fetch(new Request("http://container/mark", request));
  },
};
