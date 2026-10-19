/**
 * The last eligible regular-session trade of every symbol on IEX, read from
 * one day of IEX's own historical TOPS capture.
 *
 * WHERE THE DATA COMES FROM, AND WHY THIS SOURCE
 * ----------------------------------------------
 * IEX publishes every day's market data feed as a packet capture, free, a
 * day after the session (https://iextrading.com/trading/market-data/#hist).
 * Use is governed by the IEX Historical Data Terms of Use, and the one
 * condition on showing anything built from it is the attribution in
 * IEX_ATTRIBUTION below. It is the only source of US equity prices we found
 * that costs nothing and whose terms allow a business to use it; see
 * docs/market-context.md for the others and why each was refused.
 *
 * What it is NOT is the consolidated tape. A close here is the last trade
 * that printed on IEX, which for a liquid stock is within cents of the
 * official close and for a thin one may be hours earlier or absent. So this
 * module reports when that trade happened as well as its price, and the
 * caller decides whether it is late enough in the session to stand for the
 * day (`eligibleCloses`).
 *
 * THE FORMAT, AS FAR AS THIS READS IT
 * -----------------------------------
 *   file      gzip of a pcapng capture (older days: classic pcap)
 *   packet    Ethernet, IPv4, UDP, then an IEX-TP segment
 *   segment   40-byte header (protocol 0x8003 is TOPS), then messages, each
 *             prefixed by its length as an unsigned 16-bit integer
 *   'S'       system event: R starts the regular session, M ends it, C ends
 *             the day's messages
 *   'T'       trade report: flags, timestamp, symbol, size, price, trade id
 *   'B'       trade break: the same layout, naming a trade to undo
 *
 * Everything is little-endian. Prices are fixed-point with four decimals.
 * The specification is IEX's "TOPS Specification v1.66".
 *
 * Which trades count. A trade sets the day's last price unless it is flagged
 * extended hours (0x40) or odd lot (0x20): those do not update the last sale
 * on the consolidated tape either. Intermarket sweeps, trade-through exempt
 * trades and the closing cross all do.
 *
 * Nothing in this file touches the network or the filesystem, so the test
 * feeds it a capture built in memory.
 */

import { createGunzip } from 'node:zlib';

export const IEX_ATTRIBUTION =
  'Data provided for free by IEX. By accessing or using IEX Historical Data, you agree to the IEX Historical Data Terms of Use.';
export const IEX_TERMS_URL = 'https://iextrading.com/iex-historical-data-terms/';

export const TOPS_PROTOCOL = 0x8003;
export const FLAG = { ISO: 0x80, EXTENDED_HOURS: 0x40, ODD_LOT: 0x20, TRADE_THROUGH_EXEMPT: 0x10, SINGLE_PRICE_CROSS: 0x08 };
const INELIGIBLE = FLAG.EXTENDED_HOURS | FLAG.ODD_LOT;

const MSG_TRADE = 0x54; // 'T'
const MSG_BREAK = 0x42; // 'B'
const MSG_SYSTEM = 0x53; // 'S'
const EVENT = { START_REGULAR: 0x52, END_REGULAR: 0x4d, END_MESSAGES: 0x43 };

const PCAPNG_SHB = 0x0a0d0d0a;
const PCAPNG_EPB = 6;
const PCAPNG_IDB = 1;
const PCAPNG_BOM = 0x1a2b3c4d;
const PCAP_US = 0xa1b2c3d4;
const PCAP_NS = 0xa1b23c4d;
const TWO32 = 4294967296;

/** A signed 64-bit little-endian integer as a Number. Exact below 2^53. */
const int64 = (buf, at) => buf.readInt32LE(at + 4) * TWO32 + buf.readUInt32LE(at);

/**
 * Feed it the decompressed capture in chunks of any size, then ask for the
 * result. Holds one small record per symbol and nothing else, so a 60 GB day
 * costs a few megabytes of memory.
 */
export class TopsCloseReader {
  constructor() {
    this.carry = null;
    this.format = null; // 'pcapng' | 'pcap'
    this.symbols = new Map();
    this.session = { open: null, close: null };
    this.endOfMessages = false;
    this.counts = { packets: 0, trades: 0, ineligible: 0, breaks: 0, unmatchedBreaks: 0, otherProtocol: 0 };
  }

  push(chunk) {
    let buf = this.carry ? Buffer.concat([this.carry, chunk]) : chunk;
    let off = 0;
    if (this.format === null) {
      if (buf.length < 24) {
        this.carry = buf;
        return;
      }
      const magic = buf.readUInt32LE(0);
      if (magic === PCAPNG_SHB) this.format = 'pcapng';
      else if (magic === PCAP_US || magic === PCAP_NS) {
        this.format = 'pcap';
        off = 24;
      } else throw new Error(`not a capture this reader understands (magic 0x${magic.toString(16)})`);
    }
    off = this.format === 'pcapng' ? this.#blocks(buf, off) : this.#records(buf, off);
    this.carry = off < buf.length ? Buffer.from(buf.subarray(off)) : null;
  }

  #blocks(buf, off) {
    const n = buf.length;
    while (off + 12 <= n) {
      const type = buf.readUInt32LE(off);
      const len = buf.readUInt32LE(off + 4);
      if (type === PCAPNG_SHB && buf.readUInt32LE(off + 8) !== PCAPNG_BOM) {
        throw new Error('big-endian pcapng is not supported');
      }
      if (len < 12 || len % 4 !== 0) throw new Error(`malformed pcapng block at ${off} (length ${len})`);
      if (off + len > n) break;
      if (type === PCAPNG_EPB) this.#packet(buf, off + 28, buf.readUInt32LE(off + 20));
      else if (type === PCAPNG_IDB && buf.readUInt16LE(off + 8) !== 1) {
        throw new Error('capture link type is not Ethernet');
      }
      off += len;
    }
    return off;
  }

  #records(buf, off) {
    const n = buf.length;
    while (off + 16 <= n) {
      const len = buf.readUInt32LE(off + 8);
      if (off + 16 + len > n) break;
      this.#packet(buf, off + 16, len);
      off += 16 + len;
    }
    return off;
  }

  #packet(buf, p, caplen) {
    const end = p + caplen;
    let q = p + 12;
    let ether = buf.readUInt16BE(q);
    q += 2;
    if (ether === 0x8100) {
      ether = buf.readUInt16BE(q + 2);
      q += 4;
    }
    if (ether !== 0x0800 || buf[q + 9] !== 17) return; // IPv4 carrying UDP only
    const seg = q + (buf[q] & 0x0f) * 4 + 8;
    if (seg + 40 > end) return;
    this.counts.packets += 1;
    if (buf.readUInt16LE(seg + 2) !== TOPS_PROTOCOL) {
      this.counts.otherProtocol += 1;
      return;
    }
    const count = buf.readUInt16LE(seg + 14);
    let m = seg + 40;
    for (let i = 0; i < count && m + 2 <= end; i += 1) {
      const len = buf.readUInt16LE(m);
      const s = m + 2;
      m = s + len;
      if (m > end) break;
      const type = buf[s];
      if (type === MSG_TRADE) this.#trade(buf, s);
      else if (type === MSG_BREAK) this.#break(buf, s);
      else if (type === MSG_SYSTEM) this.#system(buf, s);
    }
  }

  #trade(buf, s) {
    this.counts.trades += 1;
    if (buf[s + 1] & INELIGIBLE) {
      this.counts.ineligible += 1;
      return;
    }
    const symbol = buf.toString('latin1', s + 10, s + 18).trimEnd();
    const size = buf.readUInt32LE(s + 18);
    const price = int64(buf, s + 22) / 1e4;
    const at = Math.floor(int64(buf, s + 2) / 1e6);
    const id = int64(buf, s + 30);
    let r = this.symbols.get(symbol);
    if (!r) {
      r = { price: NaN, at: 0, id: -1, prevPrice: NaN, prevAt: 0, prevId: -1, volume: 0, dollarVolume: 0, trades: 0 };
      this.symbols.set(symbol, r);
    }
    r.prevPrice = r.price;
    r.prevAt = r.at;
    r.prevId = r.id;
    r.price = price;
    r.at = at;
    r.id = id;
    r.volume += size;
    r.dollarVolume += size * price;
    r.trades += 1;
  }

  /**
   * A break undoes a trade. If it was the last one, the one before stands as
   * the last price; if that is broken too, the day's close for that symbol is
   * unknown, and is reported as unknown rather than guessed.
   */
  #break(buf, s) {
    this.counts.breaks += 1;
    if (buf[s + 1] & INELIGIBLE) return;
    const symbol = buf.toString('latin1', s + 10, s + 18).trimEnd();
    const r = this.symbols.get(symbol);
    if (!r) {
      this.counts.unmatchedBreaks += 1;
      return;
    }
    const size = buf.readUInt32LE(s + 18);
    const price = int64(buf, s + 22) / 1e4;
    const id = int64(buf, s + 30);
    r.volume -= size;
    r.dollarVolume -= size * price;
    if (id === r.id) {
      r.price = r.prevPrice;
      r.at = r.prevAt;
      r.id = r.prevId;
      r.prevPrice = NaN;
      r.prevId = -1;
    } else if (id === r.prevId) {
      r.prevPrice = NaN;
      r.prevId = -1;
    }
  }

  #system(buf, s) {
    const event = buf[s + 1];
    const at = Math.floor(int64(buf, s + 2) / 1e6);
    if (event === EVENT.START_REGULAR) this.session.open = at;
    else if (event === EVENT.END_REGULAR) this.session.close = at;
    else if (event === EVENT.END_MESSAGES) this.endOfMessages = true;
  }

  /**
   * `complete` is true only when the capture ran to IEX's end-of-messages
   * event and both session boundaries were seen. Anything less is a day this
   * reader did not finish, and its prices are not a close.
   */
  result() {
    const symbols = {};
    for (const [symbol, r] of this.symbols) {
      symbols[symbol] = {
        price: Number.isFinite(r.price) ? r.price : null,
        at: Number.isFinite(r.price) ? r.at : null,
        volume: r.volume,
        dollarVolume: Math.round(r.dollarVolume),
        trades: r.trades,
      };
    }
    const complete = this.endOfMessages && this.session.open !== null && this.session.close !== null && this.carry === null;
    return { format: this.format, complete, session: { ...this.session }, symbols, counts: { ...this.counts } };
  }
}

/** How close to the end of the session a last trade must be to stand for the close. */
export const CLOSE_WINDOW_MS = 30 * 60 * 1000;

/**
 * The day's closes, kept only where the last eligible trade printed in the
 * final half hour of the regular session (the session's own end, so a half
 * day is judged against one o'clock, not four). A symbol whose last IEX trade
 * was at eleven has no close that day: its price then is not the market's
 * price at the end of the day, and calling it one would put a stale number
 * into every measure built on it.
 *
 * Returns { SYMBOL: [price, volume, dollarVolume] } for the kept symbols.
 */
export function eligibleCloses(day, windowMs = CLOSE_WINDOW_MS) {
  if (!day.complete) return null;
  const from = day.session.close - windowMs;
  const out = {};
  for (const [symbol, s] of Object.entries(day.symbols)) {
    if (s.price === null || s.price <= 0 || s.at === null) continue;
    if (s.at < from || s.at > day.session.close) continue;
    if (!/^[A-Z][A-Z0-9.+=-]{0,9}$/.test(symbol)) continue;
    out[symbol] = [s.price, s.volume, s.dollarVolume];
  }
  return out;
}

/**
 * Read a gzip-compressed capture from a Node readable stream. A stream that
 * ends early (a truncated download) resolves with `complete: false` rather
 * than throwing, so the caller can record the day as not read.
 */
export async function readTopsCloses(readable, { onProgress } = {}) {
  const reader = new TopsCloseReader();
  const gunzip = createGunzip({ chunkSize: 1 << 20 });
  readable.on('error', (e) => gunzip.destroy(e));
  readable.pipe(gunzip);
  let bytes = 0;
  let error = null;
  try {
    for await (const chunk of gunzip) {
      reader.push(chunk);
      bytes += chunk.length;
      if (onProgress) onProgress(bytes, reader.counts);
    }
  } catch (e) {
    error = e;
  }
  const result = reader.result();
  if (error) {
    result.complete = false;
    result.error = String(error.message ?? error);
  }
  result.bytes = bytes;
  return result;
}
