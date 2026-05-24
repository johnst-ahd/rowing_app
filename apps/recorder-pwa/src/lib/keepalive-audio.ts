/** Silent loop + Media Session — extends background time on some mobile browsers. */

let audio: HTMLAudioElement | null = null;

const SILENT_WAV =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAAAAAA==';

export async function startKeepaliveAudio(deviceId: string): Promise<boolean> {
  stopKeepaliveAudio();
  try {
    audio = new Audio(SILENT_WAV);
    audio.loop = true;
    audio.volume = 0.01;
    await audio.play();

    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'RNZ recording',
        artist: deviceId || 'Row recorder',
        album: 'Active session',
      });
      navigator.mediaSession.playbackState = 'playing';
    }
    return true;
  } catch {
    stopKeepaliveAudio();
    return false;
  }
}

export function stopKeepaliveAudio(): void {
  if (audio) {
    audio.pause();
    audio.src = '';
    audio = null;
  }
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'none';
    navigator.mediaSession.metadata = null;
  }
}
