/**
 * IEX TOPS captures built in memory, for the market-context suite.
 *
 * Writes exactly the framing lib/iex-tops.mjs reads: pcapng (or classic
 * pcap) around Ethernet, IPv4 and UDP, an IEX-TP segment header, and
 * length-prefixed TOPS messages. Every message is one this file can make;
 * nothing here is copied from a real capture.
 */

const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const i64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
};
const symbol8 = (s) => Buffer.from(s.padEnd(8, ' '), 'latin1');

/** A trade report ('T') or, with type 'B', a trade break. Price in dollars, time in ms. */
export function tradeMessage({ type = 'T', flags = 0, atMs, symbol, size = 100, price, id }) {
  return Buffer.concat([
    Buffer.from(type, 'latin1'),
    Buffer.from([flags]),
    i64(BigInt(Math.round(atMs)) * 1000000n),
    symbol8(symbol),
    u32(size),
    i64(Math.round(price * 1e4)),
    i64(id),
  ]);
}

/** A system event: 'R' start of regular hours, 'M' end, 'C' end of messages. */
export function systemMessage(event, atMs) {
  return Buffer.concat([Buffer.from('S', 'latin1'), Buffer.from(event, 'latin1'), i64(BigInt(Math.round(atMs)) * 1000000n)]);
}

/** An Ethernet frame carrying one IEX-TP segment of `messages`. */
export function frame(messages, { protocol = 0x8003, vlan = false } = {}) {
  const payload = Buffer.concat(messages.map((m) => Buffer.concat([u16(m.length), m])));
  const seg = Buffer.concat([
    Buffer.from([1, 0]),
    u16(protocol),
    u32(1),
    u32(42),
    u16(payload.length),
    u16(messages.length),
    i64(0),
    i64(1),
    i64(0),
    payload,
  ]);
  const udp = Buffer.concat([Buffer.from([0x2b, 0x5c, 0x2b, 0x5c]), Buffer.alloc(2), Buffer.alloc(2), seg]);
  udp.writeUInt16BE(udp.length, 4);
  const ip = Buffer.alloc(20);
  ip[0] = 0x45;
  ip.writeUInt16BE(20 + udp.length, 2);
  ip[8] = 64;
  ip[9] = 17;
  const macs = Buffer.alloc(12);
  const ether = vlan ? Buffer.from([0x81, 0x00, 0x00, 0x05, 0x08, 0x00]) : Buffer.from([0x08, 0x00]);
  return Buffer.concat([macs, ether, ip, udp]);
}

function block(type, body) {
  const pad = (4 - (body.length % 4)) % 4;
  const len = 12 + body.length + pad;
  return Buffer.concat([u32(type), u32(len), body, Buffer.alloc(pad), u32(len)]);
}

/** A pcapng capture of `frames`. */
export function pcapng(frames) {
  const shb = block(0x0a0d0d0a, Buffer.concat([u32(0x1a2b3c4d), u16(1), u16(0), Buffer.alloc(8, 0xff)]));
  const idb = block(1, Buffer.concat([u16(1), u16(0), u32(65535)]));
  const epbs = frames.map((f) => block(6, Buffer.concat([u32(0), u32(0), u32(0), u32(f.length), u32(f.length), f])));
  return Buffer.concat([shb, idb, ...epbs]);
}

/** A classic (microsecond) pcap capture of `frames`, the format of IEX's oldest files. */
export function pcap(frames) {
  const head = Buffer.concat([u32(0xa1b2c3d4), u16(2), u16(4), u32(0), u32(0), u32(65535), u32(1)]);
  const recs = frames.map((f) => Buffer.concat([u32(0), u32(0), u32(f.length), u32(f.length), f]));
  return Buffer.concat([head, ...recs]);
}

/**
 * Milliseconds for a New York wall-clock time on a date, for dates in US
 * daylight time (UTC-4) unless `offsetHours` says otherwise.
 */
export const nyMs = (date, hhmm, offsetHours = 4) => {
  const [h, m] = hhmm.split(':').map(Number);
  return Date.parse(`${date}T00:00:00Z`) + ((h + offsetHours) * 60 + m) * 60000;
};

/**
 * A whole trading day: the session events, then one trade per symbol at
 * `at` (default 15:55), each at its price, then the end of messages.
 * `prices` maps symbol to dollars; `volumes` optionally maps symbol to shares.
 */
export function dayCapture(date, prices, { at = '15:55', volumes = {}, close = '16:00' } = {}) {
  const msgs = [systemMessage('R', nyMs(date, '09:30'))];
  let id = 1;
  const frames = [];
  for (const [sym, price] of Object.entries(prices)) {
    msgs.push(tradeMessage({ atMs: nyMs(date, at), symbol: sym, price, size: volumes[sym] ?? 100, id: id++ }));
    if (msgs.length >= 50) frames.push(frame(msgs.splice(0)));
  }
  msgs.push(systemMessage('M', nyMs(date, close)), systemMessage('C', nyMs(date, '20:00')));
  frames.push(frame(msgs));
  return pcapng(frames);
}
