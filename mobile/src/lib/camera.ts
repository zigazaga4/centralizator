/**
 * Capture helper — one shape (`CapturedImage`) for both the native camera
 * (Capacitor) and the web file input, so the UI never branches on platform.
 *
 * Native: the Capacitor Camera plugin opens the OS camera and returns a
 * data URL we wrap into a File. Web: the UI feeds File objects straight
 * from an <input type="file" capture> into `fileToCaptured`.
 */
import { Capacitor } from "@capacitor/core";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";

export interface CapturedImage {
  id: string;
  file: File;
  /** Object URL or data URL for the thumbnail preview. */
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

function dataUrlToFile(dataUrl: string, name: string): File {
  const comma = dataUrl.indexOf(",");
  const meta = dataUrl.slice(0, comma);
  const b64 = dataUrl.slice(comma + 1);
  const mime = /data:(.*?)(;|$)/.exec(meta)?.[1] ?? "image/jpeg";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: mime });
}

/** Native one-shot capture. Returns null if the user cancelled. */
export async function captureFromCamera(): Promise<CapturedImage | null> {
  const photo = await Camera.getPhoto({
    quality: 85,
    allowEditing: false,
    resultType: CameraResultType.DataUrl,
    source: CameraSource.Camera,
    correctOrientation: true,
  });
  if (!photo.dataUrl) return null;
  const ext = photo.format || "jpeg";
  const file = dataUrlToFile(photo.dataUrl, `scan-${uid()}.${ext}`);
  return { id: uid(), file, previewUrl: photo.dataUrl };
}

/** Web path: wrap a File chosen via <input> into a CapturedImage. */
export function fileToCaptured(file: File): CapturedImage {
  return { id: uid(), file, previewUrl: URL.createObjectURL(file) };
}
