// Web Bluetooth worker. Owns every GATT object; the main process drives it.
//
// Every function returns a JSON-serialisable value so it can cross the
// executeJavaScript boundary, and every failure becomes a rejected promise
// whose message reaches the main process intact.

(() => {
  /** handle -> { device, server, chars: Map<key, characteristic>, notifiers: Map<key, fn> } */
  const links = new Map()
  let nextHandle = 1

  const host = window.__bleHost
  host?.diag('worker loaded; navigator.bluetooth = ' + (navigator.bluetooth ? 'present' : 'MISSING'))
  void (navigator.bluetooth
    ? navigator.bluetooth.getAvailability().then(v => host?.diag(`getAvailability() (startup) = ${v}`)).catch(() => {})
    : undefined)

  function key(service, characteristic) {
    return `${String(service).toLowerCase()}/${String(characteristic).toLowerCase()}`
  }

  function hexToBuffer(hex) {
    const clean = String(hex).trim()
    if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) throw new Error(`bad hex: ${hex}`)
    const bytes = new Uint8Array(clean.length / 2)
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
    return bytes
  }

  function bufferToHex(view) {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
  }

  function link(handle) {
    const entry = links.get(handle)
    if (!entry) throw new Error(`unknown BLE handle: ${handle}`)
    if (!entry.device.gatt.connected) throw new Error(`BLE handle ${handle} is disconnected`)
    return entry
  }

  async function characteristic(handle, service, char) {
    const entry = link(handle)
    const k = key(service, char)
    const cached = entry.chars.get(k)
    if (cached) return cached
    const gattService = await entry.server.getPrimaryService(service)
    const found = await gattService.getCharacteristic(char)
    entry.chars.set(k, found)
    return found
  }

  function matchFor(filter) {
    const services = Array.isArray(filter.services) ? filter.services : []
    const match = {}
    if (filter.name) match.name = filter.name
    if (filter.namePrefix) match.namePrefix = filter.namePrefix
    // Only advertised services may appear in the match, or nothing is found.
    if (!filter.name && !filter.namePrefix && services.length > 0) match.services = services
    return match
  }

  function optionalFor(filter) {
    const services = Array.isArray(filter.services) ? filter.services : []
    const optional = Array.isArray(filter.optionalServices) ? filter.optionalServices : []
    // Access is denied to any service that was not declared up front.
    return [...new Set([...services, ...optional])]
  }

  /** stringify a thrown value without losing its name (DOMException prone to "[object Object]") */
  function describe(error) {
    const name = error && typeof error.name === 'string' ? error.name : ''
    const message = error && typeof error.message === 'string' ? error.message : String(error)
    return name ? `${name}: ${message}` : message
  }

  window.__ble = {
    // Select AND connect in one call. The platform chooser stays pending until
    // the main process answers it (grace window on the `select-bluetooth-device`
    // events); once requestDevice resolves, the device's gatt is connected
    // here, in the same context, so nothing has to survive the boundary.
    async connect(filter) {
      if (!navigator.bluetooth) throw new Error('Web Bluetooth is unavailable in this build')
      // Adapter visibility is the single most useful diagnostic: on Windows a
      // machine can show a perfectly healthy adapter in Device Manager while
      // Chromium is bound to a different, broken one (commonly a shadowed
      // duplicate). False or throwing means the page cannot scan at all.
      try {
        const available = await navigator.bluetooth.getAvailability()
        host?.diag(`getAvailability() = ${available}`)
        if (available === false) {
          throw new Error('Bluetooth adapter is not available to this page; a broken or shadowed adapter may be bound in Windows (disable duplicate Bluetooth adapters in Device Manager)')
        }
      } catch (error) {
        host?.diag(`getAvailability() failed: ${describe(error)}`)
      }
      const match = matchFor(filter)
      let device
      try {
        device = await navigator.bluetooth.requestDevice({ filters: [match], optionalServices: optionalFor(filter) })
        host?.diag(`connect: chooser approved device ${device.id}`)
      } catch (error) {
        host?.diag(`connect: requestDevice rejected: ${describe(error)}`)
        throw new Error(`requestDevice failed: ${describe(error)}`)
      }
      let server
      try {
        server = await device.gatt.connect()
      } catch (error) {
        host?.diag(`connect: gatt connect failed: ${describe(error)}`)
        throw new Error(`GATT connect failed: ${describe(error)}`)
      }
      host?.diag('connect: gatt connected')
      const handle = `ble-${nextHandle++}`
      links.set(handle, { device, server, chars: new Map(), notifiers: new Map() })

      device.addEventListener('gattserverdisconnected', () => {
        links.delete(handle)
        host?.disconnected(handle)
      })

      return { handle, name: device.name || undefined }
    },

    async read(handle, service, char) {
      const target = await characteristic(handle, service, char)
      const view = await target.readValue()
      return bufferToHex(view)
    },

    async write(handle, service, char, hex, withoutResponse) {
      const target = await characteristic(handle, service, char)
      const data = hexToBuffer(hex)
      // A 10 Hz command stream must not wait for a GATT acknowledgement, but
      // fall back when the device only advertises the acknowledged form.
      if (withoutResponse && target.properties.writeWithoutResponse) {
        await target.writeValueWithoutResponse(data)
      } else {
        await target.writeValueWithResponse(data)
      }
      return true
    },

    async subscribe(handle, service, char) {
      const target = await characteristic(handle, service, char)
      const entry = link(handle)
      const k = key(service, char)
      if (entry.notifiers.has(k)) return true
      const listener = event => {
        host?.notify(handle, service, char, bufferToHex(event.target.value))
      }
      target.addEventListener('characteristicvaluechanged', listener)
      entry.notifiers.set(k, listener)
      await target.startNotifications()
      return true
    },

    async unsubscribe(handle, service, char) {
      const entry = links.get(handle)
      if (!entry) return true
      const k = key(service, char)
      const listener = entry.notifiers.get(k)
      const target = entry.chars.get(k)
      entry.notifiers.delete(k)
      if (target && listener) {
        target.removeEventListener('characteristicvaluechanged', listener)
        try {
          await target.stopNotifications()
        } catch {
          // The link may already be gone; nothing left to stop.
        }
      }
      return true
    },

    async disconnect(handle) {
      const entry = links.get(handle)
      links.delete(handle)
      if (entry && entry.device.gatt.connected) entry.device.gatt.disconnect()
      return true
    },
  }

  host?.ready()
})()
