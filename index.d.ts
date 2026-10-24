/**
 * The backend is chosen with the REMOTECAMERA_BACKEND environment variable
 * ("auto", "ffmpeg" or "rpicam"), and the default warmup with REMOTECAMERA_WARMUP.
 */
interface CameraOptions {
  /**
   * ffmpeg: a device path or name ("/dev/video0", "0" on macOS, "Integrated Webcam" on Windows, where it is required).
   * rpicam: a camera index, default 0.
   */
  device?: string | number;
  /** Output width in pixels. Default 1280. */
  width?: number;
  /** Output height in pixels. Default 720. */
  height?: number;
}

export interface PhotoOptions extends CameraOptions {
  /** Seconds to let the camera settle before capturing. Default REMOTECAMERA_WARMUP, otherwise 1. */
  warmup?: number;
}

export interface VideoOptions extends CameraOptions {
  /** Seconds to record. Without it or a signal, records until the stream is cancelled. */
  duration?: number;
  /** Stops the recording gracefully; the stream then closes normally. */
  signal?: AbortSignal;
}

/** Takes a JPEG photo, named like "1729751234567.jpg". */
export function photo(options?: PhotoOptions): Promise<File>;

/** Records a fragmented MP4 video. */
export function video(options?: VideoOptions): ReadableStream<Uint8Array>;

declare const camera: Readonly<{ photo: typeof photo; video: typeof video }>;
export default camera;
