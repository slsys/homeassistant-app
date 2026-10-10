import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';
import { randomBytes } from 'node:crypto';
import { GatewayError } from './gateway.mjs';
import { cachedLocal, OFFLINE_TIMEOUT } from './controller-cache.mjs';

const SEARCH_DURATION = 5000;
const SEARCH_REPEAT = 2000;
const SEARCH_COOLDOWN = 10000;
const NETWORK_RETRY = 5000;

function macBytes(value) {
  const bytes =
    typeof value === 'string' && /^(?:[a-f\d]{2}:){5}[a-f\d]{2}$/i.test(value)
      ? Buffer.from(value.replaceAll(':', ''), 'hex')
      : Buffer.isBuffer(value) && value.length === 6
        ? value
        : null;
  return bytes && bytes.some((byte) => byte !== 0) && !(bytes[0] & 1) ? bytes : null;
}

// Firmware LL_ST_IDENTIFY: version 1, a 10-byte header, no payload.
export function encodeIdentify(sourceId) {
  const mac = macBytes(sourceId);
  if (!mac) throw new Error('LocalLink: invalid sender MAC');
  const packet = Buffer.alloc(10);
  packet[1] = 1;
  mac.copy(packet, 3);
  packet[9] = 1;
  return packet;
}

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
      ['Modkam v1.0 CC2538 2019', 'Modkam v1.1 CC2538 SD 2019', 'Modkam v2.0 CC2652 SD 2021'][
        revision
      ] || 'Modkam'
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
  constructor(
    options = {},
    {
      createSocket = dgram.createSocket,
      interfaces = networkInterfaces,
      clock = () => performance.now(),
    } = {},
  ) {
    this.options = {
      multicast_address: '224.0.0.50',
      multicast_port: 8881,
      interfaces: [],
      ...options,
    };
    const first = Number(this.options.multicast_address.split('.')[0]);
    if (!isIPv4(this.options.multicast_address) || first < 224 || first > 239)
      throw new Error('LocalLink: multicast_address must be an IPv4 multicast address');
    if (
      !Number.isInteger(this.options.multicast_port) ||
      this.options.multicast_port < 1 ||
      this.options.multicast_port > 65535
    )
      throw new Error('LocalLink: invalid UDP port');
    if (
      !Array.isArray(this.options.interfaces) ||
      this.options.interfaces.some((ip) => !isIPv4(ip))
    )
      throw new Error('LocalLink: interfaces must contain local IPv4 addresses');
    this.devices = new Map();
    this.restored = new Map();
    this.tracked = new Set();
    this.memberships = new Set();
    this.interfaceInfo = new Map();
    this.createSocket = createSocket;
    this.interfaces = interfaces;
    this.clock = clock;
    this.fallbackId = randomBytes(6);
    this.fallbackId[0] = (this.fallbackId[0] | 2) & 0xfe;
    this.stopped = true;
    this.nextSearch = 0;
    this.autoSearchPending = false;
    this.scan = null;
    this.status = {
      listening: false,
      group: this.options.multicast_address,
      port: this.options.multicast_port,
      interfaces: [],
      error: null,
      search: null,
    };
  }
  ingest(data, sourceIP) {
    const device = decodeHeartbeat(data, sourceIP);
    if (!device) return;
    if (!this.devices.has(device.id) && this.devices.size >= 512) {
      const oldest =
        [...this.devices.keys()].find((id) => !this.tracked.has(id)) ||
        this.devices.keys().next().value;
      this.devices.delete(oldest);
      this.restored.delete(oldest);
    }
    this.devices.set(device.id, device);
    this.restored.delete(device.id);
    if (this.scan && this.scan.replies.size < 512) {
      this.scan.replies.add(device.id);
      this.status.search.received = this.scan.replies.size;
      this.status.search.newCount = [...this.scan.replies].filter(
        (id) => !this.scan.known.has(id),
      ).length;
    }
  }
  list(now = Date.now()) {
    for (const [id, item] of this.devices)
      if (
        !this.tracked.has(id) &&
        now - Math.max(item.lastSeen, this.restored.get(id) || 0) > 86400000
      ) {
        this.devices.delete(id);
        this.restored.delete(id);
      }
    return [...this.devices.values()].map((item) => ({
      ...item,
      online: !this.restored.has(item.id) && now - item.lastSeen < OFFLINE_TIMEOUT,
      availability: this.restored.has(item.id)
        ? now - this.restored.get(item.id) < OFFLINE_TIMEOUT
          ? 'unknown'
          : 'offline'
        : now - item.lastSeen < OFFLINE_TIMEOUT
          ? 'online'
          : 'offline',
    }));
  }
  restore(items, now = Date.now()) {
    for (const item of items) {
      const device = cachedLocal(item);
      if (!device || this.devices.has(device.id) || this.devices.size >= 512) continue;
      this.devices.set(device.id, device);
      this.restored.set(device.id, now);
    }
  }
  joinInterfaces() {
    if (!this.status.listening || this.stopped) return;
    const wanted = new Map();
    for (const [name, entries] of Object.entries(this.interfaces())) {
      for (const entry of entries || []) {
        if (!['IPv4', 4].includes(entry.family) || entry.internal) continue;
        if (this.options.interfaces.length && !this.options.interfaces.includes(entry.address))
          continue;
        wanted.set(entry.address, { mac: entry.mac, key: name + '/' + entry.mac });
      }
    }
    for (const address of this.memberships)
      if (
        !wanted.has(address) ||
        wanted.get(address).key !== this.interfaceInfo.get(address)?.key
      ) {
        try {
          this.socket.dropMembership(this.options.multicast_address, address);
        } catch {
          /* interface disappeared */
        }
        this.memberships.delete(address);
        this.interfaceInfo.delete(address);
      }
    const errors = [];
    let added = false;
    for (const [address, info] of wanted) {
      if (this.memberships.has(address)) continue;
      try {
        this.socket.addMembership(this.options.multicast_address, address);
        this.memberships.add(address);
        this.interfaceInfo.set(address, info);
        added = true;
      } catch {
        errors.push(`Не удалось подписаться на интерфейсе ${address}`);
      }
    }
    this.status.interfaces = [...this.memberships];
    this.status.error =
      errors.join('; ') || (this.memberships.size ? null : 'Нет доступных интерфейсов IPv4');
    if (added) this.autoSearchPending = true;
    if (!this.memberships.size && this.scan) this.finishSearch('Сеть недоступна; поиск прерван');
    this.maybeAutoSearch();
  }
  searchStatus() {
    return (
      this.status.search && {
        ...this.status.search,
        retryAfterMs: Math.max(0, Math.ceil(this.nextSearch - this.clock())),
      }
    );
  }
  snapshot() {
    return { ...this.status, search: this.searchStatus() };
  }
  search() {
    if (this.stopped || !this.status.listening || !this.memberships.size)
      throw new GatewayError(
        'Поиск LocalLink недоступен: нет подключения к multicast',
        'validation',
      );
    if (this.scan) return this.searchStatus();
    const wait = this.nextSearch - this.clock();
    if (wait > 0)
      throw new GatewayError(
        `Повторный поиск будет доступен через ${Math.ceil(wait / 1000)} с`,
        'validation',
      );
    this.list();
    const scan = { known: new Set(this.devices.keys()), replies: new Set(), errors: new Map() };
    this.scan = scan;
    this.nextSearch = this.clock() + SEARCH_COOLDOWN;
    this.autoSearchPending = false;
    clearTimeout(this.autoSearchTimer);
    this.status.search = {
      active: true,
      startedAt: Date.now(),
      finishedAt: null,
      received: 0,
      newCount: 0,
      error: null,
    };
    void this.sendIdentify(scan);
    this.repeatTimer = setTimeout(() => {
      void this.sendIdentify(scan);
    }, SEARCH_REPEAT).unref();
    this.finishTimer = setTimeout(() => this.finishSearch(), SEARCH_DURATION).unref();
    return this.searchStatus();
  }
  async sendIdentify(scan) {
    if (scan.sending) return;
    scan.sending = true;
    try {
      const socket = this.socket;
      // Wait for each send callback before switching the outgoing multicast interface.
      for (const address of [...this.memberships]) {
        if (this.stopped || this.scan !== scan || this.socket !== socket) return;
        if (!this.memberships.has(address)) continue;
        try {
          socket.setMulticastInterface(address);
          const packet = encodeIdentify(
            macBytes(this.interfaceInfo.get(address)?.mac) || this.fallbackId,
          );
          await new Promise((resolve, reject) => {
            socket.send(
              packet,
              this.options.multicast_port,
              this.options.multicast_address,
              (error) => (error ? reject(error) : resolve()),
            );
          });
          scan.errors.delete(address);
        } catch (error) {
          scan.errors.set(address, `Ошибка отправки IDENTIFY: ${error.code || 'UDP недоступен'}`);
        }
        if (this.scan === scan)
          this.status.search.error = [...new Set(scan.errors.values())].join('; ') || null;
      }
    } finally {
      scan.sending = false;
    }
  }
  finishSearch(error) {
    clearTimeout(this.repeatTimer);
    clearTimeout(this.finishTimer);
    if (!this.scan) return;
    this.status.search.active = false;
    this.status.search.finishedAt = Date.now();
    if (error) this.status.search.error = error;
    this.scan = null;
    this.maybeAutoSearch();
  }
  maybeAutoSearch() {
    if (
      this.stopped ||
      !this.autoSearchPending ||
      this.scan ||
      !this.status.listening ||
      !this.memberships.size
    )
      return;
    clearTimeout(this.autoSearchTimer);
    const wait = this.nextSearch - this.clock();
    if (wait > 0) {
      this.autoSearchTimer = setTimeout(() => this.maybeAutoSearch(), Math.ceil(wait)).unref();
      return;
    }
    this.search();
  }
  openSocket() {
    if (this.stopped || this.socket) return;
    const socket = this.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    const failed = (error) => {
      if (this.socket !== socket || this.stopped) return;
      this.socket = null;
      this.status.listening = false;
      this.status.error = `UDP: ${error?.code || 'сокет закрыт'}`;
      this.memberships.clear();
      this.interfaceInfo.clear();
      this.status.interfaces = [];
      this.autoSearchPending = true;
      this.finishSearch('Соединение LocalLink прервано');
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.openSocket(), NETWORK_RETRY).unref();
    };
    socket.on('message', (data, remote) => {
      if (this.socket === socket && !this.stopped) this.ingest(data, remote.address);
    });
    socket.on('error', failed);
    socket.on('close', () => failed());
    try {
      socket.bind(this.options.multicast_port, '0.0.0.0', () => {
        if (this.socket !== socket || this.stopped) return;
        try {
          socket.setMulticastTTL(1);
          this.status.listening = true;
          this.joinInterfaces();
        } catch (error) {
          failed(error);
        }
      });
    } catch (error) {
      failed(error);
    }
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.openSocket();
    this.timer = setInterval(() => this.joinInterfaces(), NETWORK_RETRY).unref();
  }
  close() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.autoSearchTimer);
    this.finishSearch('Поиск остановлен');
    this.autoSearchPending = false;
    this.status.listening = false;
    this.status.interfaces = [];
    this.memberships.clear();
    this.interfaceInfo.clear();
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      /* not running */
    }
  }
}
