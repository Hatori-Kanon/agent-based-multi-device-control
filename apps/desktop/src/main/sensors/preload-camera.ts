/** Push channel from the hidden camera page back to the main process. */

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('__cameraHost', {
  /** The MediaStream ended on its own (USB unplugged, privacy switch). */
  ended: (reason: string) => { ipcRenderer.send('camera:ended', { reason }) },
  diag: (message: string) => { ipcRenderer.send('camera:diag', message) },
})
