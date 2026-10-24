import { after, afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import camera, { photo, video } from "./index.js";

class Proc extends EventEmitter {
  constructor(bin, args) {
    super();
    Object.assign(this, { bin, args, input: "", signals: [] });
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin.on("data", (chunk) => (this.input += chunk));
  }
  kill(signal) {
    this.signals.push(signal);
    this.emit("signal", signal);
    return true;
  }
  exit(code, { stdout, stderr, signal = null } = {}) {
    if (stdout) this.stdout.write(stdout);
    if (stderr) this.stderr.write(stderr);
    this.stdout.end();
    this.stderr.end();
    Promise.all([finished(this.stdout), finished(this.stderr)]).then(() =>
      this.emit("close", code, signal),
    );
  }
  // Resolves even if stdin already ended before the listener was attached
  eof(fn) {
    finished(this.stdin).then(fn);
  }
  enoent() {
    this.emit(
      "error",
      Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    );
  }
}

let spawned;
const mockSpawn = (behave) => {
  spawned = [];
  mock.method(cp, "spawn", (bin, args) => {
    const proc = new Proc(bin, args);
    spawned.push(proc);
    setImmediate(() => behave(proc));
    return proc;
  });
};
const jpeg = (proc) => proc.exit(0, { stdout: "jpeg" });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "remotecamera-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Puts fake executables on an isolated PATH
const binaries = (...names) => {
  const dir = fs.mkdtempSync(path.join(tmp, "bin-"));
  for (const name of names)
    fs.writeFileSync(path.join(dir, name), "", { mode: 0o755 });
  process.env.PATH = dir;
};

const platform = Object.getOwnPropertyDescriptor(process, "platform");
const setPlatform = (value) =>
  Object.defineProperty(process, "platform", { ...platform, value });

const read = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
};

const fresh = () => import(`./index.js?${Math.random()}`);

let env;
beforeEach(() => {
  env = { ...process.env };
  delete process.env.REMOTECAMERA_BACKEND;
  delete process.env.REMOTECAMERA_WARMUP;
  delete process.env.FFMPEG_PATH;
  binaries("ffmpeg");
  setPlatform("linux");
  mockSpawn(jpeg);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in env)) delete process.env[key];
  }
  Object.assign(process.env, env);
  Object.defineProperty(process, "platform", platform);
  mock.restoreAll();
  mock.timers.reset();
});

const LINUX_FFMPEG_PHOTO = [
  ...["-loglevel", "error", "-f", "v4l2", "-i", "/dev/video0"],
  ...["-ss", "1", "-frames:v", "1", "-vf", "scale=1280:720"],
  ...["-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"],
];
const MP4 = ["-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"];

test("default export is a frozen object with the named exports", () => {
  assert.equal(typeof camera, "object");
  assert.ok(Object.isFrozen(camera));
  assert.deepEqual(Object.keys(camera).sort(), ["photo", "video"]);
  assert.equal(camera.photo, photo);
  assert.equal(camera.video, video);
  assert.throws(() => camera(), TypeError);
});

test("photo resolves to a JPEG File", async () => {
  const img = await camera.photo();
  assert.ok(img instanceof File);
  assert.equal(img.type, "image/jpeg");
  assert.match(img.name, /^\d+\.jpg$/);
  assert.equal(await img.text(), "jpeg");
});

test("ffmpeg photo arguments on linux", async () => {
  process.env.REMOTECAMERA_BACKEND = "ffmpeg";
  await camera.photo();
  assert.equal(spawned[0].bin, "ffmpeg");
  assert.deepEqual(spawned[0].args, LINUX_FFMPEG_PHOTO);

  await camera.photo({
    device: "/dev/video2",
    width: 640,
    height: 480,
    warmup: 0,
  });
  assert.deepEqual(spawned[1].args.slice(4, 10), [
    "-i",
    "/dev/video2",
    "-ss",
    "0",
    "-frames:v",
    "1",
  ]);
  assert.ok(spawned[1].args.includes("scale=640:480"));
});

test("ffmpeg photo arguments on darwin", async () => {
  setPlatform("darwin");
  await camera.photo();
  assert.deepEqual(spawned[0].args.slice(0, 8), [
    ...["-loglevel", "error", "-f", "avfoundation"],
    ...["-framerate", "30", "-i", "0"],
  ]);
  await camera.photo({ device: 1 });
  assert.equal(spawned[1].args[7], "1");
});

test("ffmpeg photo on win32 requires a device", async () => {
  setPlatform("win32");
  await assert.rejects(camera.photo(), /"device" option is required/);
  await camera.photo({ device: "Integrated Webcam" });
  assert.deepEqual(spawned[0].args.slice(2, 6), [
    "-f",
    "dshow",
    "-i",
    "video=Integrated Webcam",
  ]);
});

test("unsupported platforms reject", async () => {
  setPlatform("freebsd");
  await assert.rejects(camera.photo(), /Unsupported platform: freebsd/);
});

test("rpicam photo arguments", async () => {
  process.env.REMOTECAMERA_BACKEND = "rpicam";
  binaries("rpicam-still");
  await camera.photo();
  assert.equal(spawned[0].bin, "rpicam-still");
  assert.deepEqual(spawned[0].args, [
    ...["-n", "--camera", "0", "--width", "1280", "--height", "720"],
    ...["-e", "jpg", "-t", "1000", "-o", "-"],
  ]);

  await camera.photo({ device: 1, width: 640, height: 480, warmup: 2.5 });
  assert.deepEqual(spawned[1].args, [
    ...["-n", "--camera", "1", "--width", "640", "--height", "480"],
    ...["-e", "jpg", "-t", "2500", "-o", "-"],
  ]);
});

test("rpicam photo with warmup 0 uses --immediate instead of -t 0", async () => {
  process.env.REMOTECAMERA_BACKEND = "rpicam";
  await camera.photo({ warmup: 0 });
  assert.ok(spawned[0].args.includes("--immediate"));
  assert.ok(!spawned[0].args.includes("-t"));
});

test("rpicam is rejected outside linux", async () => {
  process.env.REMOTECAMERA_BACKEND = "rpicam";
  setPlatform("darwin");
  await assert.rejects(camera.photo(), /only works on Linux/);
});

test("REMOTECAMERA_BACKEND is read at call time", async () => {
  binaries("ffmpeg", "rpicam-still");
  process.env.REMOTECAMERA_BACKEND = "rpicam";
  await camera.photo();
  process.env.REMOTECAMERA_BACKEND = "ffmpeg";
  await camera.photo();
  assert.deepEqual(
    spawned.map((p) => p.bin),
    ["rpicam-still", "ffmpeg"],
  );
});

test("an invalid REMOTECAMERA_BACKEND throws naming the variable", async () => {
  process.env.REMOTECAMERA_BACKEND = "webcam";
  await assert.rejects(camera.photo(), /REMOTECAMERA_BACKEND/);
  assert.throws(() => camera.video(), /REMOTECAMERA_BACKEND/);
  assert.equal(spawned.length, 0);
});

test("REMOTECAMERA_WARMUP sets the default warmup", async () => {
  process.env.REMOTECAMERA_BACKEND = "ffmpeg";
  process.env.REMOTECAMERA_WARMUP = "3";
  await camera.photo();
  assert.equal(spawned[0].args[spawned[0].args.indexOf("-ss") + 1], "3");

  await camera.photo({ warmup: 0.5 });
  assert.equal(spawned[1].args[spawned[1].args.indexOf("-ss") + 1], "0.5");

  process.env.REMOTECAMERA_BACKEND = "rpicam";
  await camera.photo();
  assert.equal(spawned[2].args[spawned[2].args.indexOf("-t") + 1], "3000");
});

test("an invalid REMOTECAMERA_WARMUP throws naming the variable", async () => {
  for (const value of ["soon", "-1"]) {
    process.env.REMOTECAMERA_WARMUP = value;
    await assert.rejects(camera.photo(), /REMOTECAMERA_WARMUP/);
  }
  assert.equal(spawned.length, 0);
});

const LIST =
  "Available cameras\n-----------------\n0 : imx708 [4608x2592 10-bit RGGB] (/base/soc/i2c0mux/i2c@1/imx708@1a)\n";
const listCameras = (output) => (proc) =>
  proc.args[0] === "--list-cameras"
    ? proc.exit(0, { stdout: output })
    : jpeg(proc);

test("auto uses rpicam when --list-cameras finds a camera", async () => {
  binaries("ffmpeg", "rpicam-still");
  mockSpawn(listCameras(LIST));
  const { photo } = await fresh();
  await photo();
  await photo();
  assert.deepEqual(
    spawned.map((p) => [p.bin, p.args[0]]),
    [
      ["rpicam-still", "--list-cameras"],
      ["rpicam-still", "-n"],
      ["rpicam-still", "-n"],
    ],
  );
});

test("auto uses ffmpeg when --list-cameras finds none", async () => {
  binaries("ffmpeg", "rpicam-still");
  mockSpawn(listCameras("No cameras available!\n"));
  const { photo } = await fresh();
  await photo();
  assert.deepEqual(
    spawned.map((p) => p.bin),
    ["rpicam-still", "ffmpeg"],
  );
});

test("auto uses ffmpeg when rpicam-still is missing", async () => {
  const { photo } = await fresh();
  await photo();
  assert.deepEqual(
    spawned.map((p) => p.bin),
    ["ffmpeg"],
  );
});

test("auto always uses ffmpeg on darwin and win32", async () => {
  binaries("ffmpeg", "rpicam-still");
  mockSpawn(listCameras(LIST));
  for (const name of ["darwin", "win32"]) {
    setPlatform(name);
    const { photo } = await fresh();
    await photo({ device: "cam" });
  }
  assert.deepEqual(
    spawned.map((p) => p.bin),
    ["ffmpeg", "ffmpeg"],
  );
});

test("falls back to the libcamera-* names", async () => {
  binaries("ffmpeg", "libcamera-still", "libcamera-vid");
  mockSpawn((proc) =>
    proc.args[0] === "--list-cameras"
      ? proc.exit(0, { stdout: LIST })
      : proc.exit(0, { stdout: "x" }),
  );
  const { photo, video } = await fresh();
  await photo();
  await read(video({ duration: 1 }));
  assert.deepEqual(
    spawned.map((p) => p.bin),
    ["libcamera-still", "libcamera-still", "libcamera-vid", "ffmpeg"],
  );
});

test("photo rejects with stderr on a non-zero exit", async () => {
  mockSpawn((proc) =>
    proc.exit(1, { stderr: "/dev/video0: No such file or directory" }),
  );
  await assert.rejects(
    camera.photo(),
    /exit code 1.*No such file or directory/,
  );
});

test("photo rejects when no bytes are produced", async () => {
  mockSpawn((proc) => proc.exit(0, { stderr: "nothing to see" }));
  await assert.rejects(camera.photo(), /produced no image: nothing to see/);
});

test("a missing binary rejects with how to install it", async () => {
  process.env.PATH = "";
  mockSpawn((proc) => proc.enoent());
  await assert.rejects(
    camera.photo(),
    /ffmpeg was not found.*brew install ffmpeg/,
  );

  process.env.FFMPEG_PATH = "/opt/ffmpeg";
  await assert.rejects(camera.photo(), /FFMPEG_PATH is "\/opt\/ffmpeg"/);
  delete process.env.FFMPEG_PATH;

  process.env.REMOTECAMERA_BACKEND = "rpicam";
  await assert.rejects(
    camera.photo(),
    /rpicam-still was not found.*sudo apt install rpicam-apps/,
  );
});

test("rpicam video explains that ffmpeg is needed for video", async () => {
  process.env.REMOTECAMERA_BACKEND = "rpicam";
  mockSpawn((proc) =>
    proc.bin === "ffmpeg" ? proc.enoent() : proc.exit(0, { stdout: "h264" }),
  );
  await assert.rejects(
    read(camera.video({ duration: 1 })),
    /needs ffmpeg \(photos do not\)/,
  );
});

test("ffmpeg video arguments and output", async () => {
  process.env.REMOTECAMERA_BACKEND = "ffmpeg";
  mockSpawn((proc) => proc.exit(0, { stdout: "mp4" }));
  assert.equal(await read(camera.video({ duration: 5 })), "mp4");
  assert.deepEqual(spawned[0].args, [
    ...["-loglevel", "error", "-f", "v4l2", "-i", "/dev/video0"],
    ...["-t", "5", "-vf", "scale=1280:720"],
    ...["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"],
    ...MP4,
  ]);

  await read(camera.video());
  assert.ok(!spawned[1].args.includes("-t"));
});

test("rpicam video pipes rpicam-vid into ffmpeg", async () => {
  process.env.REMOTECAMERA_BACKEND = "rpicam";
  mockSpawn((proc) => {
    if (proc.bin === "rpicam-vid") return proc.exit(0, { stdout: "h264" });
    proc.eof(() => proc.exit(0, { stdout: "mp4" }));
  });
  assert.equal(await read(camera.video({ device: 1, duration: 2 })), "mp4");
  const [vid, ff] = spawned;
  assert.equal(vid.bin, "rpicam-vid");
  assert.deepEqual(vid.args, [
    ...["-n", "--camera", "1", "--width", "1280", "--height", "720"],
    ...[
      "--framerate",
      "30",
      "--codec",
      "h264",
      "--inline",
      "-t",
      "2000",
      "-o",
      "-",
    ],
  ]);
  assert.equal(ff.bin, "ffmpeg");
  assert.deepEqual(ff.args, [
    ...["-loglevel", "error", "-framerate", "30", "-f", "h264", "-i", "pipe:0"],
    ...["-c:v", "copy", ...MP4],
  ]);
  assert.equal(ff.input, "h264");
});

test("video errors the stream on a non-zero exit", async () => {
  process.env.REMOTECAMERA_BACKEND = "ffmpeg";
  mockSpawn((proc) =>
    proc.exit(1, { stdout: "partial", stderr: "Device busy" }),
  );
  await assert.rejects(read(camera.video()), /Device busy/);
});

for (const failing of ["rpicam-vid", "ffmpeg"]) {
  test(`video errors the stream when only ${failing} fails in the rpicam pipeline`, async () => {
    process.env.REMOTECAMERA_BACKEND = "rpicam";
    mockSpawn((proc) => {
      if (proc.bin === failing)
        return proc.exit(1, { stderr: `${failing} broke` });
      proc.stdout.write("data");
    });
    await assert.rejects(read(camera.video()), new RegExp(`${failing} broke`));
    const other = spawned.find((p) => p.bin !== failing);
    assert.deepEqual(other.signals, ["SIGKILL"]);
  });
}

test("an already aborted signal throws immediately", () => {
  assert.throws(() => camera.video({ signal: AbortSignal.abort() }), {
    name: "AbortError",
  });
});

test("abort writes q to ffmpeg and the stream closes normally", async () => {
  process.env.REMOTECAMERA_BACKEND = "ffmpeg";
  const controller = new AbortController();
  mockSpawn((proc) => {
    proc.stdout.write("frag1");
    proc.eof(() => proc.exit(0, { stdout: "frag2" }));
    controller.abort();
  });
  assert.equal(
    await read(camera.video({ signal: controller.signal })),
    "frag1frag2",
  );
  assert.equal(spawned[0].input, "q");
  assert.deepEqual(spawned[0].signals, []);
});

test("abort sends SIGINT to rpicam-vid and ffmpeg finalizes on EOF", async () => {
  process.env.REMOTECAMERA_BACKEND = "rpicam";
  const controller = new AbortController();
  mockSpawn((proc) => {
    if (proc.bin === "ffmpeg") {
      return proc.eof(() => proc.exit(0, { stdout: "mp4" }));
    }
    proc.stdout.write("h264");
    proc.on("signal", (signal) => proc.exit(null, { signal }));
    controller.abort();
  });
  assert.equal(await read(camera.video({ signal: controller.signal })), "mp4");
  const [vid, ff] = spawned;
  assert.deepEqual(vid.signals, ["SIGINT"]);
  assert.equal(vid.args[vid.args.indexOf("-t") + 1], "0");
  assert.equal(ff.input, "h264");
  assert.deepEqual(ff.signals, []);
});

test("abort kills and errors if the camera does not stop within 5 seconds", async () => {
  process.env.REMOTECAMERA_BACKEND = "ffmpeg";
  mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  mockSpawn((proc) => {
    proc.on("signal", (signal) => proc.exit(null, { signal }));
    controller.abort();
    mock.timers.tick(5000);
  });
  await assert.rejects(
    read(camera.video({ signal: controller.signal })),
    /did not stop within 5 seconds/,
  );
  assert.deepEqual(spawned[0].signals, ["SIGKILL"]);
});

test("cancelling the stream kills every process", async () => {
  process.env.REMOTECAMERA_BACKEND = "rpicam";
  mockSpawn((proc) => proc.stdout.write("data"));
  const reader = camera.video().getReader();
  await reader.read();
  await reader.cancel();
  assert.deepEqual(
    spawned.map((p) => p.signals),
    [["SIGKILL"], ["SIGKILL"]],
  );
});
