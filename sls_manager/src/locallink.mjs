import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';

// Mirrors hwVer_t and GetBoardName() in the SLS firmware.
export function boardName(hardware, revision) {
  const names = [
    'Custom DIY',
    'Modkam',
    'SLS Classic',
    'SLS DIN Mini',
    'SLS Hub',
    'SLS Hub Max',
    'SLS DIN PLC',
    'SLS DIN PLC Max',
    'SLS DIN IM',
    'SLS DIN IO',
    'SLS DIN Hub',
    'SLS I-Stick',
    'SLS DIN 4R',
    'ZigbeeShop Classic Pro',
    'SLS DIN 8R',
    'SLS DIN Micro',
    'SLS DIN Micro RF',
    'SLS DIN 16R',
  ];
  if (hardware === 1)
    return (
      ['Modkam v1.0 CC2538 2019', 'Modkam v1.1 CC2538 SD 2019', 'Modkam v2.0 CC2652 SD 2021'][revision] ||
      'Modkam'
    );
  const name = names[hardware];
  if (!name) return `Неизвестная плата (${hardware}, rev. ${revision})`;
  if (!hardware) return name;
  const maxRevision = { 2: 1, 3: 2, 4: 3, 5: 3, 7: 2, 10: 1 }[hardware] ?? 0;
  return revision <= maxRevision ? `${name} v1.${revision}` : `${name} (rev. ${revision})`;
}

// Firmware Link_Local.h: packed 10-byte header + 55-byte heartbeat.
// Len is currently zero on the wire; use the UDP datagram length, not Len.
export function decodeHeartbeat(data, sourceIP, now = Date.now()) {
  if (!Buffer.isBuffer(data) || data.length !== 65 || data[1] !== 1 || data[9] !== 2) return null;
  if (
    !isIPv4(sourceIP) ||
    data.subarray(3, 9).every((b) => b === 0) ||
    data.subarray(3, 9).every((b) => b === 255)
  )
    return null;
  const cstring = (offset, length) =>
    data
      .subarray(offset, offset + length)
      .toString('utf8')
      .split('\0', 1)[0]
      .replace(/[\x00-\x1f\x7f]/g, '');
  return {
    id: data.subarray(3, 9).toString('hex').match(/../g).join(':').toUpperCase(),
    address: sourceIP,
    advertisedAddress: [...data.subarray(31, 35)].join('.'),
    name: cstring(35, 30),
    version: cstring(10, 15),
    board: boardName(data[25], data[26]),
    hardware: data[25],
    revision: data[26],
    uptime: data.readUInt32LE(27),
    lastSeen: now,
  };
}

export class LocalLink {
  constructor(options = {}) {
    this.options = { multicast_address: '224.0.0.50', multicast_port: 8881, interfaces: [], ...options };
    const first = Number(this.options.multicast_address.split('.')[0]);
    if (!isIPv4(this.options.multicast_address) || first < 224 || first > 239)
      throw new Error('LocalLink: multicast_address must be an IPv4 multicast address');
    if (
      !Number.isInteger(this.options.multicast_port) ||
      this.options.multicast_port < 1 ||
      this.options.multicast_port > 65535
    )
      throw new Error('LocalLink: invalid UDP port');
    if (!Array.isArray(this.options.interfaces) || this.options.interfaces.some((ip) => !isIPv4(ip)))
      throw new Error('LocalLink: interfaces must contain local IPv4 addresses');
    this.devices = new Map();
    this.memberships = new Set();
    this.status = {
      listening: false,
      group: this.options.multicast_address,
      port: this.options.multicast_port,
      interfaces: [],
      error: null,
    };
  }
  ingest(data, sourceIP) {
    const device = decodeHeartbeat(data, sourceIP);
    if (!device) return;
    if (!this.devices.has(device.id) && this.devices.size >= 512)
      this.devices.delete(this.devices.keys().next().value);
    this.devices.set(device.id, device);
  }
  list(now = Date.now()) {
    for (const [id, item] of this.devices) if (now - item.lastSeen > 86400000) this.devices.delete(id);
    return [...this.devices.values()].map((item) => ({ ...item, online: now - item.lastSeen < 180000 }));
  }
  joinInterfaces() {
    const addresses = this.options.interfaces.length
      ? this.options.interfaces
      : Object.values(networkInterfaces())
          .flat()
          .filter((i) => i.family === 'IPv4' && !i.internal)
          .map((i) => i.address);
    const wanted = new Set(addresses);
    for (const address of this.memberships)
      if (!wanted.has(address)) {
        try {
          this.socket.dropMembership(this.options.multicast_address, address);
        } catch {
          /* interface disappeared */
        }
        this.memberships.delete(address);
      }
    const errors = [];
    for (const address of wanted) {
      if (this.memberships.has(address)) continue;
      try {
        this.socket.addMembership(this.options.multicast_address, address);
        this.memberships.add(address);
      } catch {
        errors.push(`Не удалось подписаться на интерфейсе ${address}`);
      }
    }
    this.status.interfaces = [...this.memberships];
    this.status.error =
      errors.join('; ') || (this.memberships.size ? null : 'Нет доступных интерфейсов IPv4');
  }
  start() {
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('message', (data, remote) => this.ingest(data, remote.address));
    this.socket.on('error', (error) => {
      this.status.error = `UDP: ${error.code || 'ошибка сокета'}`;
    });
    this.socket.on('close', () => {
      this.status.listening = false;
    });
    this.socket.bind(this.options.multicast_port, '0.0.0.0', () => {
      this.status.listening = true;
      this.joinInterfaces();
      this.timer = setInterval(() => this.joinInterfaces(), 30000);
      this.timer.unref();
    });
  }
  close() {
    clearInterval(this.timer);
    try {
      this.socket?.close();
    } catch {
      /* not running */
    }
  }
}
