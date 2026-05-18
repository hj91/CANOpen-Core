'use strict';
/**
 * canopen_bus.js  v6
 * ─────────────────────────────────────────────────────────────────────────────
 * Universal hardware transport layer for CANopen gateway.
 * Exposes a unified API regardless of the underlying physical adapter:
 * * VirtualCANBus   – in-process event bus (Desktop dev / simulator)
 * * SocketCANBus    – Linux native socketcan (can0, can1)
 * * USRSerialBus    – USR-CAN114 over RS485/serial (COM port)
 * * TCPCANBus       – Ethernet to CAN (Raw TCP socket)
 * * SLCANBus        – Lawicel / CANable over USB (COM port)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const EventEmitter = require('events');
const net = require('net');

class Reconnector {
  constructor(emitter, connectFn, opts = {}) {
    this._emitter    = emitter;
    this._connectFn  = connectFn;
    this._baseDelay  = opts.baseDelay || 1000;
    this._maxDelay   = opts.maxDelay  || 30000;
    this._factor     = opts.factor    || 2;
    this._attempt    = 0;
    this._timer      = null;
    this._cancelled  = false;   
    this._active     = false;   
  }

  onConnected() {
    this._attempt  = 0;
    this._active   = false;
    this._cancelled = false;
  }

  onDropped() {
    if (this._cancelled || this._active) return;
    this._active = true;
    this._scheduleNext();
  }

  cancel() {
    this._cancelled = true;
    this._active    = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  _scheduleNext() {
    if (this._cancelled) return;
    const delay = Math.min(this._baseDelay * Math.pow(this._factor, this._attempt), this._maxDelay);
    this._attempt++;
    this._emitter.emit('bus_reconnecting', { attempt: this._attempt, delayMs: delay });
    this._timer = setTimeout(() => this._retry(), delay);
  }

  async _retry() {
    if (this._cancelled) return;
    this._timer = null;
    try {
      await this._connectFn();
    } catch (err) {
      this._scheduleNext();
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. VirtualCANBus 
// ═══════════════════════════════════════════════════════════════════════════════
class VirtualCANBus extends EventEmitter {
  constructor(interfaceName) {
    super();
    this.interfaceName = interfaceName;
    this.statsData = { rx: 0, tx: 0, err: 0 };
  }
  connect() {
    setTimeout(() => this.emit('bus_connected'), 100);
  }
  send(canId, data) {
    this.statsData.tx++;
    setTimeout(() => this.emit('frame', { id: canId, data: Buffer.from(data), ts: Date.now() }), 1);
  }
  stats() { return this.statsData; }
  close() { this.removeAllListeners(); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. SocketCANBus (Linux Native)
// ═══════════════════════════════════════════════════════════════════════════════
class SocketCANBus extends EventEmitter {
  constructor(interfaceName, config = {}) {
    super();
    this.interfaceName = interfaceName;
    this.channel = null;
    this.statsData = { rx: 0, tx: 0, err: 0 };
    this._reconnect = new Reconnector(this, () => this._doConnect());
  }

  connect() {
    this._reconnect.cancel();           
    this._reconnect._cancelled = false; 
    this._doConnect();
  }

  _doConnect() {
    if (this.channel) {
      try { this.channel.stop(); } catch (_) {}
      this.channel = null;
    }

    try {
      let rawcan;
      try {
        rawcan = require('rawcan');
      } catch (reqErr) {
        throw new Error('SocketCAN is a Linux-only feature. To test on Windows, set busType to "slcan", "tcp", or "virtual".');
      }

      this.channel = rawcan.createSocket(this.interfaceName);

      this.channel.on('message', (id, buffer) => {
        this.statsData.rx++;
        this.emit('frame', { id, data: buffer, ts: Date.now() });
      });

      this.channel.on('error', err => {
        this.statsData.err++;
        this.emit('bus_error', err);
        this._reconnect.onDropped();
      });

      this._reconnect.onConnected();
      this.emit('bus_connected');
    } catch (e) {
      const err = new Error(`SocketCAN failed on ${this.interfaceName}: ${e.message}`);
      this.emit('bus_error', err);
      this._reconnect.onDropped();
      throw err; 
    }
  }

  send(canId, data) {
    if (!this.channel) return;
    try {
      this.channel.send(canId, Buffer.from(data));
      this.statsData.tx++;
    } catch (e) {
      this.statsData.err++;
    }
  }
  stats() { return this.statsData; }
  close() {
    this._reconnect.cancel();
    if (this.channel) { this.channel.stop(); this.channel = null; }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. USRSerialBus 
// ═══════════════════════════════════════════════════════════════════════════════
class USRSerialBus extends EventEmitter {
  constructor(config) {
    super();
    this.portName   = config.port;
    this.baudRate   = config.baudRate || 115200;
    this.port       = null;
    this.statsData  = { rx: 0, tx: 0, err: 0 };
    this._buffer    = Buffer.alloc(0);
    this._reconnect = new Reconnector(this, () => this._doConnect());
  }

  connect() {
    this._reconnect.cancel();
    this._reconnect._cancelled = false;
    return this._doConnect();
  }

  async _doConnect() {
    if (this.port) {
      try { if (this.port.isOpen) this.port.close(); } catch (_) {}
      this.port = null;
    }
    this._buffer = Buffer.alloc(0); 

    const { SerialPort } = require('serialport');
    return new Promise((resolve, reject) => {
      this.port = new SerialPort({ path: this.portName, baudRate: this.baudRate }, err => {
        if (err) {
          this.emit('bus_error', err);
          this._reconnect.onDropped();
          return reject(err);
        }
      });

      this.port.on('data', data => {
        this.statsData.rx++;
        this._buffer = Buffer.concat([this._buffer, data]);
        if (this._buffer.length > 4096) this._buffer = Buffer.alloc(0);

        while (this._buffer.length >= 13) {
          if (this._buffer[0] !== 0xAA) {
            const sync = this._buffer.indexOf(0xAA, 1);
            this._buffer = sync === -1 ? Buffer.alloc(0) : this._buffer.slice(sync);
            continue;
          }
          const frame = this._buffer.slice(0, 13);
          this._buffer = this._buffer.slice(13);
          const id  = frame.readUInt16LE(1);
          const dlc = frame[3];
          this.emit('frame', { id, data: frame.slice(4, 4 + dlc), ts: Date.now() });
        }
      });

      this.port.on('open', () => {
        this._reconnect.onConnected();
        this.emit('bus_connected');
        resolve();
      });

      this.port.on('error', err => {
        this.statsData.err++;
        this.emit('bus_error', err);
        this._reconnect.onDropped();
      });

      this.port.on('close', () => {
        this.emit('bus_disconnected');
        this._reconnect.onDropped();
      });
    });
  }

  send(canId, data) {
    if (!this.port || !this.port.isOpen) return;
    const buf = Buffer.from(data);
    const out = Buffer.alloc(13);
    out[0] = 0xAA; out.writeUInt16LE(canId, 1); out[3] = buf.length;
    buf.copy(out, 4); out[12] = 0x55;
    this.port.write(out);
    this.statsData.tx++;
  }
  stats() { return this.statsData; }
  close() {
    this._reconnect.cancel();
    if (this.port && this.port.isOpen) this.port.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. TCPCANBus 
// ═══════════════════════════════════════════════════════════════════════════════
class TCPCANBus extends EventEmitter {
  constructor(config) {
    super();
    this.host       = config.tcp_host;
    this.port       = config.tcp_port;
    this.client     = null;
    this.statsData  = { rx: 0, tx: 0, err: 0 };
    this._buffer    = Buffer.alloc(0);
    this._reconnect = new Reconnector(this, () => this._doConnect());
  }

  connect() {
    this._reconnect.cancel();
    this._reconnect._cancelled = false;
    return this._doConnect();
  }

  async _doConnect() {
    if (this.client) {
      try { this.client.destroy(); } catch (_) {}
      this.client = null;
    }
    this._buffer = Buffer.alloc(0); 

    return new Promise((resolve, reject) => {
      this.client = new net.Socket();

      this.client.connect(this.port, this.host, () => {
        this._reconnect.onConnected();
        this.emit('bus_connected');
        resolve();
      });

      this.client.on('data', data => {
        this.statsData.rx++;
        this._buffer = Buffer.concat([this._buffer, data]);
        if (this._buffer.length > 4096) this._buffer = Buffer.alloc(0);

        while (this._buffer.length >= 13) {
          if (this._buffer[0] !== 0xAA) {
            const sync = this._buffer.indexOf(0xAA, 1);
            this._buffer = sync === -1 ? Buffer.alloc(0) : this._buffer.slice(sync);
            continue;
          }
          const frame = this._buffer.slice(0, 13);
          this._buffer = this._buffer.slice(13);
          const id  = frame.readUInt16LE(1);
          const dlc = frame[3];
          this.emit('frame', { id, data: frame.slice(4, 4 + dlc), ts: Date.now() });
        }
      });

      this.client.on('error', err => {
        this.statsData.err++;
        this.emit('bus_error', err);
        this._reconnect.onDropped();
        reject(err); 
      });

      this.client.on('close', () => {
        this.emit('bus_disconnected');
        this._reconnect.onDropped();
      });
    });
  }

  send(canId, data) {
    if (!this.client || this.client.destroyed) return;
    const buf = Buffer.from(data);
    const out = Buffer.alloc(13);
    out[0] = 0xAA; out.writeUInt16LE(canId, 1); out[3] = buf.length;
    buf.copy(out, 4); out[12] = 0x55;
    this.client.write(out);
    this.statsData.tx++;
  }
  stats() { return this.statsData; }
  close() {
    this._reconnect.cancel();
    if (this.client) { this.client.destroy(); this.client = null; }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. SLCANBus 
// ═══════════════════════════════════════════════════════════════════════════════
class SLCANBus extends EventEmitter {
  constructor(config) {
    super();
    this.portName   = config.comm_port;
    this.baudRate   = config.baud_rate || 115200;
    this.port       = null;
    this.statsData  = { rx: 0, tx: 0, err: 0 };
    this._reconnect = new Reconnector(this, () => this._doConnect());
  }

  connect() {
    this._reconnect.cancel();
    this._reconnect._cancelled = false;
    return this._doConnect();
  }

  async _doConnect() {
    if (this.port) {
      try { if (this.port.isOpen) { this.port.write('C\r'); this.port.close(); } } catch (_) {}
      this.port = null;
    }

    const { SerialPort }    = require('serialport');
    const { ReadlineParser } = require('@serialport/parser-readline');

    return new Promise((resolve, reject) => {
      this.port = new SerialPort({ path: this.portName, baudRate: this.baudRate }, err => {
        if (err) {
          this.emit('bus_error', err);
          this._reconnect.onDropped();
          return reject(err);
        }
      });

      const parser = this.port.pipe(new ReadlineParser({ delimiter: '\r' }));
      parser.on('data', line => {
        if (line.startsWith('t') || line.startsWith('T')) {
          this.statsData.rx++;
          const idLen   = line.startsWith('t') ? 3 : 8;
          const id      = parseInt(line.substring(1, 1 + idLen), 16);
          const dlc     = parseInt(line.substring(1 + idLen, 2 + idLen), 10);
          const payload = Buffer.alloc(dlc);
          let offset    = 2 + idLen;
          for (let i = 0; i < dlc; i++) {
            payload[i] = parseInt(line.substring(offset, offset + 2), 16);
            offset += 2;
          }
          this.emit('frame', { id, data: payload, ts: Date.now() });
        }
      });

      this.port.on('open', () => {
        this.port.write('C\rS5\rO\r');
        this._reconnect.onConnected();
        this.emit('bus_connected');
        resolve();
      });

      this.port.on('error', err => {
        this.statsData.err++;
        this.emit('bus_error', err);
        this._reconnect.onDropped();
      });

      this.port.on('close', () => {
        this.emit('bus_disconnected');
        this._reconnect.onDropped();
      });
    });
  }

  send(canId, data) {
    if (!this.port || !this.port.isOpen) return;
    const buf = Buffer.from(data);
    let out = canId <= 0x7FF ? 't' : 'T';
    out += canId.toString(16).padStart(canId <= 0x7FF ? 3 : 8, '0');
    out += buf.length.toString();
    for (let i = 0; i < buf.length; i++) {
      out += buf[i].toString(16).padStart(2, '0').toUpperCase();
    }
    out += '\r';
    this.port.write(out);
    this.statsData.tx++;
  }
  stats() { return this.statsData; }
  close() {
    this._reconnect.cancel();
    if (this.port && this.port.isOpen) { this.port.write('C\r'); this.port.close(); }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Factory Export
// ═══════════════════════════════════════════════════════════════════════════════
function createBus(config = {}) {
  const c    = config.canbus || {};
  const type = c.type || 'virtual';

  let bus;
  switch (type) {
    case 'socketcan': bus = new SocketCANBus(c.interface || 'can0', c); break;
    case 'serial':    bus = new USRSerialBus({ port: c.comm_port, baudRate: c.baud_rate }); break;
    case 'tcp':       bus = new TCPCANBus(c); break;
    case 'slcan':     bus = new SLCANBus(c); break;
    case 'virtual':
    default:          bus = new VirtualCANBus(c.interface || 'can0'); break;
  }

  if (typeof bus.onFrame !== 'function') {
    bus.onFrame = function(handler) { this.on('frame', handler); };
  }

  return bus;
}

module.exports = { createBus };