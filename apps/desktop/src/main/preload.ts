/** Narrow IPC surface exposed to the renderer. No Node access crosses over. */

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('host', {
  snapshot: () => ipcRenderer.invoke('host:snapshot'),
  info: () => ipcRenderer.invoke('host:info'),
  panic: () => ipcRenderer.invoke('host:panic'),
  unlock: () => ipcRenderer.invoke('host:unlock'),
  stop: (deviceId?: string, channelId?: string) => ipcRenderer.invoke('host:stop', deviceId, channelId),
  demo: (deviceId: string, channelId: string) => ipcRenderer.invoke('host:demo', deviceId, channelId),
  setCap: (deviceId: string, channelId: string, patch: { minPercent?: number; maxPercent?: number; minFreq?: number; maxFreq?: number; maxDurationSec?: number }) =>
    ipcRenderer.invoke('host:set-cap', deviceId, channelId, patch),
  waveforms: () => ipcRenderer.invoke('host:waveforms'),
  setWaveform: (deviceId: string, channelId: string, waveformId?: string) =>
    ipcRenderer.invoke('host:set-waveform', deviceId, channelId, waveformId),
  importWaveform: (name: string, framesText: string) =>
    ipcRenderer.invoke('host:import-waveform', name, framesText),
  promoteWaveform: (id: string) => ipcRenderer.invoke('host:promote-waveform', id),
  audit: () => ipcRenderer.invoke('host:audit'),
  scan: (deviceId: string, durationMs?: number) => ipcRenderer.invoke('host:scan', deviceId, durationMs),
  connect: (deviceId: string) => ipcRenderer.invoke('host:connect', deviceId),
  onChanged: (callback: () => void) => {
    const listener = (): void => { callback() }
    ipcRenderer.on('host:changed', listener)
    return () => { ipcRenderer.off('host:changed', listener) }
  },
  onError: (callback: (message: string) => void) => {
    const listener = (_event: unknown, message: string): void => { callback(message) }
    ipcRenderer.on('host:error', listener)
    return () => { ipcRenderer.off('host:error', listener) }
  },
})
