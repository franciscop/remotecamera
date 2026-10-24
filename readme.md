# remotecamera [![npm install remotecamera](https://img.shields.io/badge/npm%20install-remotecamera-blue.svg)](https://www.npmjs.com/package/remotecamera) [![tests](https://github.com/franciscop/remotecamera/workflows/tests/badge.svg)](https://github.com/franciscop/remotecamera/actions) [![deps](https://img.shields.io/badge/deps-0-limegreen.svg)](https://github.com/franciscop/remotecamera/blob/master/package.json)

Take photos and record video from a webcam or a Raspberry Pi camera module. Photos are a web-standard `File` and videos a `ReadableStream`, so they go straight into [`bucket`](https://github.com/franciscop/bucket), `node:fs/promises` or `fetch()`:

```js
import camera from "remotecamera";

const img = await camera.photo(); // File, "1729751234567.jpg"
const clip = camera.video({ duration: 10 }); // ReadableStream of an MP4
```

Both are also named exports:

```js
import { photo, video } from "remotecamera";
```

## Getting started

```bash
npm install remotecamera
```

It needs Node.js 20 or newer, plus the camera tools for your hardware:

- **Webcams** (Linux, macOS and Windows) use ffmpeg: `apt install ffmpeg`, `brew install ffmpeg` or `winget install ffmpeg`. Alternatively `npm install ffmpeg-static`, which is used when there is no `ffmpeg` on the PATH. On macOS, the first capture asks for camera permission for the terminal or app running Node.
- **Raspberry Pi camera module** uses `rpicam-apps`, preinstalled on Raspberry Pi OS (otherwise `sudo apt install rpicam-apps`). Recording video also needs ffmpeg; photos don't.

Nothing is installed automatically, and it never calls `sudo`. If a tool is missing, the error says which one and how to install it.

## API

### `camera.photo(options?)`

Takes a JPEG photo and returns a promise that resolves to a `File` of type `image/jpeg`, named after the current timestamp like `"1729751234567.jpg"`:

```js
const img = await camera.photo({ width: 1920, height: 1080, warmup: 2 });
```

| Option   | Default | Description                                                         |
| -------- | ------- | ------------------------------------------------------------------- |
| `device` | see below | Which camera to use.                                              |
| `width`  | `1280`  | Width in pixels.                                                    |
| `height` | `720`   | Height in pixels.                                                   |
| `warmup` | `1`     | Seconds to let the camera adjust before capturing. Defaults to `REMOTECAMERA_WARMUP` when set. |

It rejects with the camera tool's error output if the capture fails.

### `camera.video(options?)`

Starts recording right away and returns a `ReadableStream<Uint8Array>` of a fragmented MP4 (H.264):

```js
const clip = camera.video({ duration: 30 });
```

| Option     | Default | Description                                 |
| ---------- | ------- | ------------------------------------------- |
| `device`   | see below | Which camera to use.                      |
| `width`    | `1280`  | Width in pixels.                            |
| `height`   | `720`   | Height in pixels.                           |
| `duration` | none    | Seconds to record.                          |
| `signal`   | none    | An `AbortSignal` that stops the recording. See [Stopping a recording](#stopping-a-recording). |

Without `duration` or `signal`, it records until the stream is cancelled. If the camera fails mid-recording, the stream errors instead of ending, so a truncated clip is never saved or uploaded as if it were complete.

### Options per backend

The backend is picked automatically, see [Configuration](#configuration). Only `device` and `warmup` behave differently:

| Option   | ffmpeg (webcams)                                                                 | rpicam (Pi camera module)                       |
| -------- | -------------------------------------------------------------------------------- | ----------------------------------------------- |
| `device` | Device path or name: `"/dev/video0"` (Linux default), `"0"` (macOS default), `"Integrated Webcam"` (Windows, required) | Camera index, default `0`              |
| `warmup` | Skips the first seconds of frames, which are often dark or out of focus           | Time for auto exposure and white balance to settle; `0` captures immediately |

## Configuration

These environment variables describe the machine rather than a single call, so set them where the machine is configured: a `.env` file, a systemd unit, or the Docker or Coolify environment.

| Variable               | Values                            | Default         |
| ---------------------- | --------------------------------- | --------------- |
| `REMOTECAMERA_BACKEND` | `"auto"`, `"ffmpeg"` or `"rpicam"` | `"auto"`        |
| `REMOTECAMERA_WARMUP`  | Seconds, `0` or more               | `1`             |
| `FFMPEG_PATH`          | Path to the ffmpeg binary          | `ffmpeg` on the PATH, then `ffmpeg-static` |

With `"auto"`, a Raspberry Pi with a camera module uses `rpicam` and everything else uses `ffmpeg`. A `warmup` passed to `camera.photo()` always wins over `REMOTECAMERA_WARMUP`.

They're read on every call, so setting them from code also works:

```js
process.env.REMOTECAMERA_BACKEND = "ffmpeg";
const img = await camera.photo();
```

An invalid value throws an error that names the variable.

## Raspberry Pi

The official camera module is detected automatically: on Linux, when `rpicam-still --list-cameras` finds a camera, the `rpicam` backend is used. The older `libcamera-still` and `libcamera-vid` names from Raspberry Pi OS Bullseye work too. USB webcams on a Pi use the `ffmpeg` backend like on any other Linux machine.

To use a USB webcam on a Pi that also has a camera module, force the backend:

```bash
REMOTECAMERA_BACKEND=ffmpeg node app.js
```

Boards with two camera connectors, like the Pi 5 and the Compute Modules, pick the camera by index:

```js
const front = await camera.photo(); // device: 0
const back = await camera.photo({ device: 1 });
```

It runs headless out of the box, with no preview window, so it works over SSH and from a systemd service. Video is encoded by the Pi's camera stack and ffmpeg only packs it into MP4 without re-encoding, so recording is light even on a Pi Zero.

## Saving or sending the files

The photo `File` and the video stream work directly with these, no adapters needed:

- [`bucket`](https://github.com/franciscop/bucket) to store files in S3, R2, GCS, Azure, B2 or a local folder through one API.
- `node:fs/promises` to save them on the local disk.
- Native `fetch()` to send them to your own server or API. It's global in Node, no library needed.

With `bucket`:

```js
import { S3 } from "bucket";
const bucket = S3("my-bucket");

// Generated name, extension taken from the File's name
const file = await bucket.create(await camera.photo());
console.log(file.path); // "V1StGXR8Z5jdHi6BmyT2a.jpg"

// A stream carries no name, so pass the type
const clip = await bucket.create(camera.video({ duration: 30 }), { type: "mp4" });
```

With `node:fs/promises`:

```js
import fsp from "node:fs/promises";

const img = await camera.photo();
await fsp.writeFile(img.name, new Uint8Array(await img.arrayBuffer()));

// writeFile accepts async iterables, and web ReadableStreams are one
await fsp.writeFile("clip.mp4", camera.video({ duration: 30 }));
```

With `fetch()`:

```js
// Multipart form; the File keeps its name and type in FormData
const form = new FormData();
form.append("image", await camera.photo());
form.append("secret", process.env.SECRET);
await fetch("https://example.com/upload", { method: "POST", body: form });

// Or the raw photo as the body
await fetch("https://example.com/photo.jpg", { method: "PUT", body: await camera.photo() });

// Video streams straight through, never buffered in memory
await fetch("https://example.com/clip.mp4", {
  method: "PUT",
  body: camera.video({ duration: 30 }),
  headers: { "content-type": "video/mp4" },
  duplex: "half", // required by fetch when the body is a stream
});
```

A streamed `fetch()` body is sent chunked, without `Content-Length`, so the receiving server must accept chunked uploads. Video can't go in a `FormData` without buffering the whole clip first.

## Stopping a recording

Pass an `AbortSignal` to stop recording when you decide. The camera stops gracefully, the last fragment of the MP4 is finished, and then the stream ends normally:

```js
const controller = new AbortController();
setTimeout(() => controller.abort(), 60_000);

const clip = camera.video({ signal: controller.signal });
await bucket.create(clip, { type: "mp4" });
```

Don't pass that same signal to `bucket.create()` or `fetch()`. It should stop the camera, after which the upload completes on its own when the stream ends; sharing it would cancel the upload and lose the clip.

## FAQ

### The photo is dark or blurry

Webcams adjust exposure and focus during their first frames. Increase `warmup`, per call or for the whole machine with `REMOTECAMERA_WARMUP`.

### How do I find the device name?

| Platform       | Command                                            |
| -------------- | -------------------------------------------------- |
| Linux          | `v4l2-ctl --list-devices`                          |
| macOS          | `ffmpeg -f avfoundation -list_devices true -i ""`  |
| Windows        | `ffmpeg -list_devices true -f dshow -i dummy`      |
| Pi camera module | `rpicam-still --list-cameras`                    |

## Migrating from v1

Version 2 only captures; saving and uploading moved to the tools above.

| v1                                   | v2                                                              |
| ------------------------------------ | --------------------------------------------------------------- |
| `remotecamera(options, callback)`    | `await camera.photo(options)`                                   |
| `url`, `form`, `data`                | `fetch()` with a `FormData`: `form` is the field name, `data` are extra fields |
| `folder`, `name`                     | `node:fs/promises` or `bucket`                                  |
| `width`, `height`                    | The same options on `camera.photo()`                            |
| `streamer`, `imagesnap`              | ffmpeg, or rpicam-apps on a Pi camera module, chosen automatically or with `REMOTECAMERA_BACKEND` |
| CommonJS `require()`                 | ESM `import`                                                    |
