/** Push channel from the BLE worker page back to the main process. */

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('__bleHost', {
  ready: () => { ipcRenderer.send('ble:ready') },
  notify: (handle: string, service: string, characteristic: string, hex: string) => {
    ipcRenderer.send('ble:notify', { handle, service, characteristic, hex })
  },
  disconnected: (handle: string) => { ipcRenderer.send('ble:disconnected', { handle }) },
})
