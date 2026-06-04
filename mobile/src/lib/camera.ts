/**
 * Camera plumbing for the live scanner.
 *
 * Unlike the old flow (which launched the OS camera app for one photo via
 * the Capacitor Camera plugin), the scanner needs a *live* in-app preview
 * it can analyse frame by frame. That means `getUserMedia` straight into a
 * <video>, which the Capacitor Android WebView grants once the native
 * CAMERA permission is held (see ensureCameraPermission + the manifest).
 *
 * One shape — `CapturedImage` — flows to the upload list, whether it came
 * from a captured video frame or (fallback) a picked file.
 */
import { Capacitor } from "@capacitor/core";
import { Camera } from "@capacitor/camera";

export interface CapturedImage {
  id: string;
  file: File;
  /** Object URL for the thumbnail preview (revoke on removal). */
  previewUrl: string;
}

let counter = 0;
function uid(): string {
  counter += 1;
  return `${Date.now()}-${counter}`;
}

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * Make sure the WebView is allowed to open the camera. On native we must
 * hold the runtime CAMERA permission first (Capacitor only grants the web
 * getUserMedia request when the native permission is already granted). On
 * the web the browser prompts on getUserMedia itself, so this is a no-op.
 */
export async function ensureCameraPermission(): Promise<boolean> {
  if (!isNative()) return true;
  try {
    const status = await Camera.checkPermissions();
    if (status.camera === "granted") return true;
    const req = await Camera.requestPermissions({ permissions: ["camera"] });
    return req.camera === "granted";
  } catch {
    return false;
  }
}

/** Open the rear camera at the highest reasonable resolution and bind it
 *  to `video`. Resolves once frames are actually flowing. */
export async function startStream(video: HTMLVideoElement): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: false,
  });
  video.srcObject = stream;
  // iOS Safari/WebView needs these for autoplay of a live stream.
  video.setAttribute("playsinline", "true");
  video.muted = true;
  await video.play();
  return stream;
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}

/** Grab the current video frame at full sensor resolution as a JPEG File. */
export async function captureFrame(video: HTMLVideoElement): Promise<CapturedImage> {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) throw new Error("Camera nu este pregătită încă.");

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Nu pot crea contextul de captură.");
  ctx.drawImage(video, 0, 0, w, h);

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Captura a eșuat."))), "image/jpeg", 0.9),
  );
  const id = uid();
  const file = new File([blob], `scan-${id}.jpg`, { type: "image/jpeg" });
  return { id, file, previewUrl: URL.createObjectURL(blob) };
}

/** Fallback: wrap a File chosen via <input> (used only if the camera is
 *  unavailable or permission was denied). */
export function fileToCaptured(file: File): CapturedImage {
  return { id: uid(), file, previewUrl: URL.createObjectURL(file) };
}
