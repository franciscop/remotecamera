import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Environment variables are read at call time, so changes to process.env apply
function backendEnv() {
  const value = process.env.REMOTECAMERA_BACKEND || "auto";
  if (["auto", "ffmpeg", "rpicam"].includes(value)) return value;
  throw new Error(
    `REMOTECAMERA_BACKEND must be "auto", "ffmpeg" or "rpicam", got "${value}"`,
  );
}

function warmupEnv() {
  const value = process.env.REMOTECAMERA_WARMUP?.trim();
  if (!value) return 1;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  throw new Error(
    `REMOTECAMERA_WARMUP must be a number of seconds, 0 or more, got "${value}"`,
  );
}

function onPath(name) {
  const exts =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT || ".EXE").split(";")]
      : [""];
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  return dirs.some((dir) =>
    exts.some((ext) => {
      try {
        fs.accessSync(path.join(dir, name + ext), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );
}

async function ffmpegBin() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  if (onPath("ffmpeg")) return "ffmpeg";
  try {
    const { default: bin } = await import("ffmpeg-static");
    if (bin) return bin;
  } catch {}
  return "ffmpeg";
}

// Raspberry Pi OS Bullseye ships rpicam-apps under the older libcamera-* names
const rpicamBin = (tool) =>
  [`rpicam-${tool}`, `libcamera-${tool}`].find(onPath);

let detected;

async function resolveBackend(choice = backendEnv()) {
  if (choice === "rpicam" && process.platform !== "linux") {
    throw new Error(
      `The rpicam backend only works on Linux (Raspberry Pi), not on ${process.platform}`,
    );
  }
  if (choice !== "auto") return choice;
  if (process.platform !== "linux") return "ffmpeg";
  return (detected ??= detectPiCamera());
}

// Not based on /dev/video*: the Pi 5 exposes those for its ISP even without a webcam
async function detectPiCamera() {
  const bin = rpicamBin("still");
  if (!bin) return "ffmpeg";
  const output = await new Promise((resolve) => {
    let text = "";
    const proc = cp.spawn(bin, ["--list-cameras"]);
    proc.stdout.on("data", (chunk) => (text += chunk));
    proc.stderr.on("data", (chunk) => (text += chunk));
    proc.on("error", () => resolve(""));
    proc.on("close", () => resolve(text));
  });
  // Cameras are listed as "0 : imx708 [4608x2592 10-bit RGGB] (...)"
  return /^\s*\d+\s*:/m.test(output) ? "rpicam" : "ffmpeg";
}

async function ffmpeg(args, prefix = "") {
  const bin = await ffmpegBin();
  const hint = process.env.FFMPEG_PATH
    ? `FFMPEG_PATH is "${bin}", but no ffmpeg was found there`
    : `${prefix}ffmpeg was not found. Install it with "apt install ffmpeg", "brew install ffmpeg" or "winget install ffmpeg", or run "npm i ffmpeg-static"`;
  return { bin, args: ["-loglevel", "error", ...args], hint };
}

function rpicam(tool, args) {
  const bin = rpicamBin(tool) ?? `rpicam-${tool}`;
  const hint = `${bin} was not found. Install it with "sudo apt install rpicam-apps" (it comes preinstalled on Raspberry Pi OS)`;
  return { bin, args, hint };
}

function ffmpegInput(device) {
  switch (process.platform) {
    case "linux":
      return ["-f", "v4l2", "-i", String(device ?? "/dev/video0")];
    case "darwin":
      return [
        ...["-f", "avfoundation", "-framerate", "30"],
        ...["-i", String(device ?? "0")],
      ];
    case "win32":
      if (device == null) {
        throw new Error(
          'On Windows the "device" option is required, e.g. { device: "Integrated Webcam" }. List cameras with: ffmpeg -list_devices true -f dshow -i dummy',
        );
      }
      return ["-f", "dshow", "-i", `video=${device}`];
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

// rpicam-apps take milliseconds, and "-t 0" means "run forever"
const ms = (seconds) => String(Math.max(1, Math.round(seconds * 1000)));

// A regular MP4 needs a seekable output, and stdout is a pipe
const MP4 = ["-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"];

const photoPlans = {
  ffmpeg: ({ device, width, height, warmup }) =>
    ffmpeg([
      ...ffmpegInput(device),
      ...["-ss", String(warmup), "-frames:v", "1"],
      ...["-vf", `scale=${width}:${height}`],
      ...["-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"],
    ]),
  rpicam: async ({ device = 0, width, height, warmup }) =>
    rpicam("still", [
      ...["-n", "--camera", String(device)],
      ...["--width", String(width), "--height", String(height), "-e", "jpg"],
      ...(warmup > 0 ? ["-t", ms(warmup)] : ["--immediate"]),
      ...["-o", "-"],
    ]),
};

const videoPlans = {
  ffmpeg: async ({ device, width, height, duration }) => ({
    steps: [
      await ffmpeg([
        ...ffmpegInput(device),
        ...(duration ? ["-t", String(duration)] : []),
        ...["-vf", `scale=${width}:${height}`],
        // Webcams often output 4:2:2, which browsers and QuickTime cannot play
        ...["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"],
        ...MP4,
      ]),
    ],
    stop: ([ff]) => ff.stdin.end("q"),
  }),
  rpicam: async ({ device = 0, width, height, duration }) => ({
    steps: [
      rpicam("vid", [
        ...["-n", "--camera", String(device)],
        ...["--width", String(width), "--height", String(height)],
        ...["--framerate", "30", "--codec", "h264", "--inline"],
        ...["-t", duration ? ms(duration) : "0", "-o", "-"],
      ]),
      // Raw H.264 has no timestamps, so -framerate must match rpicam-vid's
      await ffmpeg(
        [
          ...["-framerate", "30", "-f", "h264", "-i", "pipe:0"],
          ...["-c:v", "copy", ...MP4],
        ],
        "Recording video from the Raspberry Pi camera needs ffmpeg (photos do not). ",
      ),
    ],
    // ffmpeg's stdin is the video pipe, so stop the camera and let ffmpeg finish on EOF
    stop: ([vid]) => vid.kill("SIGINT"),
  }),
};

function run({ bin, args, hint }, stdio) {
  const proc = cp.spawn(bin, args, { stdio });
  let stderr = "";
  proc.stderr.on("data", (chunk) => (stderr += chunk));
  const done = new Promise((resolve, reject) => {
    proc.on("error", (error) => {
      reject(
        error.code === "ENOENT" ? new Error(hint, { cause: error }) : error,
      );
    });
    proc.on("close", (code, signal) => {
      if (code === 0) return resolve(stderr.trim());
      const reason = signal ?? `exit code ${code}`;
      const details = stderr.trim() ? `: ${stderr.trim()}` : "";
      reject(
        Object.assign(new Error(`${bin} failed (${reason})${details}`), {
          signal,
        }),
      );
    });
  });
  return { proc, done };
}

export async function photo({
  device,
  width = 1280,
  height = 720,
  warmup = warmupEnv(),
} = {}) {
  const backend = await resolveBackend();
  const step = await photoPlans[backend]({ device, width, height, warmup });
  const { proc, done } = run(step, ["ignore", "pipe", "pipe"]);
  const chunks = [];
  proc.stdout.on("data", (chunk) => chunks.push(chunk));
  const stderr = await done;
  if (!chunks.length) {
    throw new Error(
      `${step.bin} produced no image${stderr ? `: ${stderr}` : ""}`,
    );
  }
  return new File(chunks, `${Date.now()}.jpg`, { type: "image/jpeg" });
}

export function video({
  device,
  width = 1280,
  height = 720,
  duration,
  signal,
} = {}) {
  signal?.throwIfAborted();
  const choice = backendEnv();
  let controller, plan, timer;
  let procs = [];
  let stopping = false;
  let finished = false;

  const end = (kill) => {
    if (finished) return false;
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    if (kill) for (const { proc } of procs) proc.kill("SIGKILL");
    return true;
  };
  const fail = (error) => end(true) && controller.error(error);

  // Stops the recording gracefully so the last fragment is finalized
  const stop = () => {
    stopping = true;
    plan.stop(procs.map(({ proc }) => proc));
    timer = setTimeout(() => {
      fail(new Error("The camera did not stop within 5 seconds of the abort"));
    }, 5000);
  };

  return new ReadableStream({
    async start(ctrl) {
      controller = ctrl;
      plan = await videoPlans[await resolveBackend(choice)]({
        device,
        width,
        height,
        duration,
      });
      if (finished) return;
      if (signal?.aborted) return end(false) && controller.close();

      procs = plan.steps.map((step) => run(step, "pipe"));
      for (let i = 1; i < procs.length; i++) {
        procs[i - 1].proc.stdout.pipe(procs[i].proc.stdin);
      }
      // EPIPE when a process exits early; its exit code reports the real error
      for (const { proc } of procs) proc.stdin.on("error", () => {});

      const out = procs.at(-1).proc.stdout;
      out.on("data", (chunk) => {
        if (finished) return;
        controller.enqueue(chunk);
        if (controller.desiredSize <= 0) out.pause();
      });

      const exits = procs.map(({ done }) =>
        done.catch((error) => {
          // rpicam-vid may die from the SIGINT we sent; ffmpeg still finalizes on EOF
          if (!(stopping && error.signal === "SIGINT")) throw error;
        }),
      );
      Promise.all(exits).then(() => end(false) && controller.close(), fail);
      signal?.addEventListener("abort", stop, { once: true });
    },
    pull() {
      procs.at(-1)?.proc.stdout.resume();
    },
    cancel() {
      end(true);
    },
  });
}

export default Object.freeze({ photo, video });
