// The microphone and camera a call uses. Device ids are per site and say nothing about the
// account, so they sit in plain localStorage like the server address.
const STORAGE_KEY = "umbrachat:mediaDevices";

export interface MediaChoice {
  audioId?: string;
  videoId?: string;
}

export function loadMediaChoice(): MediaChoice {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as MediaChoice;
  } catch {
    return {};
  }
}

export function saveMediaChoice(choice: MediaChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Not remembered: calls keep using the browser's default devices.
  }
}

/**
 * Opens the microphone (and camera) for a call: the chosen devices exactly, since browsers may
 * ignore a mere preference, else the defaults (a chosen device may have been unplugged).
 */
export async function openCallMedia(video: boolean): Promise<MediaStream> {
  const { audioId, videoId } = loadMediaChoice();
  if (audioId || (video && videoId)) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: audioId ? { deviceId: { exact: audioId } } : true,
        video: video ? (videoId ? { deviceId: { exact: videoId } } : true) : false,
      });
    } catch (err) {
      // Permission refused: asking again for the defaults would only be refused too.
      if (err instanceof DOMException && err.name === "NotAllowedError") throw err;
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: true, video });
}

export async function listDevices(kind: MediaDeviceKind): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind && d.deviceId);
}
