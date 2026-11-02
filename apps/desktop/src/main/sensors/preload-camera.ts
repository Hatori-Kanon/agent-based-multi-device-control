/** Push channel from the hidden camera/microphone worker page back to the main process. */

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('__cameraHost', {
  /** The video MediaStream ended on its own (USB unplugged, privacy switch). */
  ended: (reason: string) => { ipcRenderer.send('camera:ended', { reason }) },
  /** The audio stream ended on its own (device removed, permission revoked). */
  audioEnded: (reason: string) => { ipcRenderer.send('audio:ended', { reason }) },
  diag: (message: string) => { ipcRenderer.send('camera:diag', message) },
})
