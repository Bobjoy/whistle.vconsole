/**
 * A debug session = one live page (probe connection).
 *
 * The server keeps a bounded, id-deduplicated buffer per stream so agents
 * can query history with `since` cursors and keep reading data for a while
 * after the probe disconnects.
 */

import type {
  LogItem, NetworkItem, NetworkRequestType, PageInfo, RealDeviceHints,
} from '@bobjoy/vconsole-protocol';
import { PROTOCOL_VERSION, WS_BINARY_MARKER } from '@bobjoy/vconsole-protocol';
import { parseDeviceLabel, realDeviceFromDeviceName } from './deviceLabel.js';

interface IndexedLog {
  idx: number;
  item: LogItem;
}
interface IndexedNetwork {
  idx: number;
  item: NetworkItem;
}

/**
 * A single WebSocket frame, flattened out of a network item's `messages`
 * array so agents can stream frames incrementally without re-fetching the
 * whole connection each poll. `data` is always a string here: the probe
 * pre-encodes binary payloads as base64 (WS_BINARY_MARKER), and the hub
 * strips that marker so a frame is either plain text or pure base64.
 */
export interface WsFrame {
  wsUrl: string;
  /** monotonically increasing per `wsUrl`; a connection that reconnects continues the same counter */
  seq: number;
  type: 'send' | 'receive';
  data: string;
  /** epoch ms */
  time: number;
  /** original byte count, only set when a binary frame was capped to WS_BINARY_MAX_BYTES */
  totalBytes?: number;
}

export type NetworkRequestBucket = 'css' | 'js' | 'img' | 'xhr' | 'ws' | 'other';

const REQUEST_TYPE_BUCKET: Record<string, NetworkRequestBucket> = {
  stylesheet: 'css',
  script: 'js',
  img: 'img',
  xhr: 'xhr',
  fetch: 'xhr',
  ping: 'xhr',
  custom: 'xhr',
  websocket: 'ws',
};

/** Coarse request-type buckets for the `type` filter; unmatched types are `other`. */
export function networkBucket(requestType: NetworkRequestType): NetworkRequestBucket {
  return REQUEST_TYPE_BUCKET[requestType] || 'other';
}

/** List row: everything but the heavy bodies/headers/WS frames (detail mode has those). */
export type NetworkListItem =
  Omit<NetworkItem, 'requestHeader' | 'responseHeader' | 'postData' | 'response' | 'getData' | 'messages'> &
  { bucket: NetworkRequestBucket };

export interface LogWaiter {
  kind: 'log';
  predicate: (item: LogItem) => boolean;
  resolve: (item: LogItem) => void;
  timer: ReturnType<typeof setTimeout>;
}
export interface NetworkWaiter {
  kind: 'network';
  predicate: (item: NetworkItem) => boolean;
  resolve: (item: NetworkItem) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Session {
  public id: string;
  public deviceName?: string;
  /** human-readable device info parsed from the UA, e.g. "iPhone · iOS 16.0 · WeChat 8.0.28" */
  public deviceLabel?: string;
  public probeVersion?: string;
  /**
   * The protocol the probe reported in `hello` when it differs from ours —
   * a signal, never a cutoff (ADR-008): an old page must keep working against
   * a new hub, but the operator has to be able to see why results look odd.
   */
  public protocolMismatch?: number;
  public page?: PageInfo;
  public online = false;
  public firstSeenAt = Date.now();
  public lastSeenAt = Date.now();

  public ws: any = null; // WebSocket

  private logMap = new Map<string, IndexedLog>();
  private logList: IndexedLog[] = [];
  private logIdx = 0;
  private networkMap = new Map<string, IndexedNetwork>();
  private networkList: IndexedNetwork[] = [];
  private networkIdx = 0;

  // WebSocket frame stream: a dedicated ring buffer (decoupled from the
  // network item buffer, so frame-dense connections never evict other
  // network entries). `expandedUpTo` tracks how many of a given network
  // item's `messages` we've already flattened, because the probe re-pushes
  // the full message array on every update (hub dedupes the item by id).
  // `wsLastFrame` keeps the frame we recorded for that tail message so a Blob
  // (readable only asynchronously, so the probe patches it in place) can be
  // refreshed after the fact.
  private readonly wsFrameMax = 2000;
  private wsFrameBuffer: WsFrame[] = [];
  private wsUrlSeq = new Map<string, number>();
  private expandedUpTo = new Map<string, number>();
  private wsLastFrame = new Map<string, { frame: WsFrame; raw: unknown }>();

  private logBufferMax: number;
  private networkBufferMax: number;

  private logWaiters = new Set<LogWaiter>();
  private networkWaiters = new Set<NetworkWaiter>();

  constructor(id: string, logBufferMax = 2000, networkBufferMax = 500) {
    this.id = id;
    this.logBufferMax = logBufferMax;
    this.networkBufferMax = networkBufferMax;
  }

  // -------------------------------------------------------------------------
  // connection
  // -------------------------------------------------------------------------

  public attach(ws: any, hello: {
    deviceName?: string;
    realDevice?: RealDeviceHints;
    probeVersion?: string;
    protocol?: number;
    page?: PageInfo;
  }) {
    this.ws = ws;
    this.online = true;
    this.lastSeenAt = Date.now();
    if (hello.deviceName) { this.deviceName = hello.deviceName; }
    if (hello.probeVersion) { this.probeVersion = hello.probeVersion; }
    // only a reported number can disagree; a probe old enough to stay silent
    // is unknowable, and guessing would put fake warnings on real sessions
    this.protocolMismatch = typeof hello.protocol === 'number' && hello.protocol !== PROTOCOL_VERSION
      ? hello.protocol : undefined;
    if (hello.page) {
      this.page = hello.page;
      // refresh the UA-derived label on every hello (UA can change on reload);
      // client-hints values win over the UA (which freezes the model to "K"),
      // with the previous-generation deviceName format as a fallback
      const real = hello.realDevice || realDeviceFromDeviceName(hello.deviceName);
      this.deviceLabel = parseDeviceLabel(hello.page.userAgent || '', real);
    }
  }

  public detach(closingWs?: any) {
    // idempotent per connection: a superseded socket closing must not mark
    // the session offline when a newer connection already took over
    if (closingWs && this.ws && closingWs !== this.ws) { return; }
    this.ws = null;
    this.online = false;
    this.lastSeenAt = Date.now();
    // fail any pending waiters? No: waiters keep waiting (data may resume on
    // reconnect); the MCP tool timeout handles abandonment.
  }

  // -------------------------------------------------------------------------
  // data ingestion (dedupe by id, last write wins)
  // -------------------------------------------------------------------------

  public addLogs(items: LogItem[], reset: boolean) {
    if (reset) {
      this.logList = [];
      this.logMap.clear();
    }
    for (const item of items) {
      const existing = this.logMap.get(item.id);
      if (existing) {
        existing.item = item;
        continue;
      }
      const idx = ++this.logIdx;
      const entry = { idx, item };
      this.logMap.set(item.id, entry);
      this.logList.push(entry);
      this.notifyLogWaiters(item);
    }
    this.evictLogs();
  }

  public addNetwork(items: NetworkItem[], reset: boolean) {
    if (reset) {
      this.networkList = [];
      this.networkMap.clear();
      this.wsFrameBuffer = [];
      this.expandedUpTo.clear();
    }
    for (const item of items) {
      const existing = this.networkMap.get(item.id);
      if (existing) {
        existing.item = item;
      } else {
        const idx = ++this.networkIdx;
        const entry = { idx, item };
        this.networkMap.set(item.id, entry);
        this.networkList.push(entry);
        this.notifyNetworkWaiters(item);
      }
      this.expandWsFrames(item);
    }
    this.evictNetwork();
  }

  /**
   * Flatten a WS network item's newly-appended messages into the frame ring.
   * The probe re-pushes the full `messages` array on every update, so we
   * only expand the tail beyond what we've already recorded for this item.
   */
  private expandWsFrames(item: NetworkItem) {
    if (item.requestType !== 'websocket' || !item.messages) { return; }
    const prior = this.expandedUpTo.get(item.id) || 0;
    const messages = item.messages;
    // a Blob is only readable asynchronously, so the probe replaces that message's
    // data in place after we've flattened it — re-decode the tail when it changed
    if (prior > 0 && prior <= messages.length) {
      const kept = this.wsLastFrame.get(item.id);
      const tail = messages[prior - 1];
      if (kept && kept.raw !== tail.data) {
        Object.assign(kept.frame, this.normalizeWsData(tail.data));
        this.wsLastFrame.set(item.id, { frame: kept.frame, raw: tail.data });
      }
    }
    for (let i = Math.max(0, prior); i < messages.length; i++) {
      const m = messages[i];
      const seq = (this.wsUrlSeq.get(item.url) || 0) + 1;
      this.wsUrlSeq.set(item.url, seq);
      const norm = this.normalizeWsData(m.data);
      const frame: WsFrame = {
        wsUrl: item.url, seq, type: m.type, data: norm.data, time: m.time,
      };
      if (norm.totalBytes !== undefined) { frame.totalBytes = norm.totalBytes; }
      this.wsFrameBuffer.push(frame);
      this.wsLastFrame.set(item.id, { frame, raw: m.data });
    }
    this.expandedUpTo.set(item.id, messages.length);
    if (this.wsFrameBuffer.length > this.wsFrameMax) {
      this.wsFrameBuffer.shift();
    }
  }

  /**
   * The probe pre-encodes binary frames as WS_BINARY_MARKER + base64 (plus the
   * original byte count when it had to cap them); everything else is text.
   */
  private normalizeWsData(data: unknown): { data: string; totalBytes?: number } {
    if (typeof data === 'string') {
      if (data.indexOf(WS_BINARY_MARKER) !== 0) { return { data }; }
      const body = data.slice(WS_BINARY_MARKER.length);
      const cut = body.lastIndexOf(':');
      // ':' never appears in base64, so a trailing one separates the original size
      if (cut > 0) {
        const total = Number(body.slice(cut + 1));
        return { data: body.slice(0, cut), totalBytes: total > 0 ? total : undefined };
      }
      return { data: body };
    }
    if (data === null || data === undefined) { return { data: String(data) }; }
    try {
      return { data: JSON.stringify(data) };
    } catch {
      return { data: String(data) };
    }
  }

  public getWsFrames(opts: {
    wsUrl?: string; sinceFrameTime?: number; limit?: number;
  }): { frames: WsFrame[]; nextSince: number; oldestSeq: number } {
    const { wsUrl, sinceFrameTime, limit = 50 } = opts;
    const filtered = this.wsFrameBuffer.filter((f) => {
      if (wsUrl && f.wsUrl !== wsUrl) { return false; }
      if (sinceFrameTime !== undefined && f.time <= sinceFrameTime) { return false; }
      return true;
    });
    const selected = filtered.slice(Math.max(0, filtered.length - limit));
    const oldest = this.wsFrameBuffer[0];
    return {
      frames: selected,
      nextSince: selected.length > 0 ? selected[selected.length - 1].time : 0,
      oldestSeq: oldest ? oldest.seq : 0,
    };
  }

  private evictLogs() {
    while (this.logList.length > this.logBufferMax) {
      const evicted = this.logList.shift();
      if (evicted) { this.logMap.delete(evicted.item.id); }
    }
  }

  private evictNetwork() {
    while (this.networkList.length > this.networkBufferMax) {
      const evicted = this.networkList.shift();
      if (evicted) { this.networkMap.delete(evicted.item.id); }
    }
  }

  // -------------------------------------------------------------------------
  // queries
  // -------------------------------------------------------------------------

  public getLogs(opts: {
    level?: string; keyword?: string; since?: number; limit?: number;
  }): { items: LogItem[]; nextSince: number; dropped: number } {
    const { level, keyword, since, limit = 100 } = opts;
    const lowerKeyword = keyword ? keyword.toLowerCase() : undefined;
    const filtered = this.logList.filter(({ idx, item }) => {
      if (since !== undefined && idx <= since) { return false; }
      if (level && item.type !== level) { return false; }
      if (lowerKeyword) {
        const hay = `${item.args.join(' ')}`.toLowerCase();
        if (!hay.includes(lowerKeyword)) { return false; }
      }
      return true;
    });
    const dropped = filtered.length - limit;
    const selected = filtered.slice(Math.max(0, filtered.length - limit));
    const nextSince = selected.length > 0 ? selected[selected.length - 1].idx : (since || 0);
    return {
      items: selected.map((e) => e.item),
      nextSince,
      dropped: Math.max(0, dropped),
    };
  }

  public getNetwork(opts: {
    urlFilter?: string; since?: number; limit?: number; type?: string;
  }): { items: NetworkListItem[]; nextSince: number; dropped: number } {
    const { urlFilter, since, limit = 50, type } = opts;
    const lowerFilter = urlFilter ? urlFilter.toLowerCase() : undefined;
    const filtered = this.networkList.filter(({ idx, item }) => {
      if (since !== undefined && idx <= since) { return false; }
      if (type && networkBucket(item.requestType) !== type) { return false; }
      if (lowerFilter) {
        const hay = `${item.method} ${item.url} ${item.status}`.toLowerCase();
        if (!hay.includes(lowerFilter)) { return false; }
      }
      return true;
    });
    const dropped = filtered.length - limit;
    const selected = filtered.slice(Math.max(0, filtered.length - limit));
    const nextSince = selected.length > 0 ? selected[selected.length - 1].idx : (since || 0);
    return {
      // list rows stay light: bodies, headers and WS frames only come through
      // getNetworkById (the tool's requestId mode), so 100 rows never blow
      // past the tool result text cap
      items: selected.map(({ item }) => ({
        id: item.id,
        requestType: item.requestType,
        bucket: networkBucket(item.requestType),
        method: item.method,
        url: item.url,
        name: item.name,
        status: item.status,
        statusText: item.statusText,
        readyState: item.readyState,
        cancelState: item.cancelState,
        responseType: item.responseType,
        responseSize: item.responseSize,
        startTime: item.startTime,
        endTime: item.endTime,
        costTime: item.costTime,
        transferSize: item.transferSize,
        replayedFrom: item.replayedFrom,
      })),
      nextSince,
      dropped: Math.max(0, dropped),
    };
  }

  public getNetworkById(requestId: string): NetworkItem | undefined {
    return this.networkMap.get(requestId)?.item;
  }

  public clearLogBuffer() {
    this.logList = [];
    this.logMap.clear();
    this.networkList = [];
    this.networkMap.clear();
  }

  public summary() {
    return {
      sessionId: this.id,
      deviceName: this.deviceName,
      deviceLabel: this.deviceLabel,
      online: this.online,
      probeVersion: this.probeVersion,
      ...(this.protocolMismatch !== undefined ? { protocolMismatch: this.protocolMismatch } : {}),
      url: this.page?.url,
      title: this.page?.title,
      userAgent: this.page?.userAgent,
      viewport: this.page?.viewport,
      logCount: this.logList.length,
      networkCount: this.networkList.length,
      firstSeenAt: this.firstSeenAt,
      lastSeenAt: this.lastSeenAt,
    };
  }

  // -------------------------------------------------------------------------
  // waiters (for wait_for)
  // -------------------------------------------------------------------------

  private notifyLogWaiters(item: LogItem) {
    for (const w of this.logWaiters) {
      if (w.predicate(item)) {
        this.logWaiters.delete(w);
        clearTimeout(w.timer);
        w.resolve(item);
      }
    }
  }

  private notifyNetworkWaiters(item: NetworkItem) {
    for (const w of this.networkWaiters) {
      if (w.predicate(item)) {
        this.networkWaiters.delete(w);
        clearTimeout(w.timer);
        w.resolve(item);
      }
    }
  }

  public waitForLog(predicate: (item: LogItem) => boolean, timeoutMs: number): Promise<LogItem> {
    return new Promise<LogItem>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.logWaiters.delete(waiter);
        reject(new Error(`timeout after ${timeoutMs}ms waiting for log`));
      }, timeoutMs);
      const waiter: LogWaiter = { kind: 'log', predicate, resolve, timer };
      this.logWaiters.add(waiter);
    });
  }

  public waitForNetwork(predicate: (item: NetworkItem) => boolean, timeoutMs: number): Promise<NetworkItem> {
    return new Promise<NetworkItem>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.networkWaiters.delete(waiter);
        reject(new Error(`timeout after ${timeoutMs}ms waiting for network`));
      }, timeoutMs);
      const waiter: NetworkWaiter = { kind: 'network', predicate, resolve, timer };
      this.networkWaiters.add(waiter);
    });
  }
}
