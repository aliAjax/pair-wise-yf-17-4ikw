// 持久层：写盘失败隔离 + 离线包校验
//
// 设计要点：
// 1. 分区写：每条记录独立一个 localStorage 键，单条写失败/损坏不波及已确认记录
// 2. 校验和：每条记录附 checksum；读取时校验，损坏条目单独隔离，不拖垮整体读取
// 3. 写盘故障注入：writeFailures>0 时写操作抛错（模拟现场存储介质故障），
//    未写入内容留在内存队列，故障解除后可重新提交，且按批次 id 幂等不重复计数

export interface StoredEnvelope<T> {
  id: string;
  payload: T;
  checksum: string;
  writtenAt: number;
}

const PREFIX = "organledger.v1.";

export function checksum(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 故障注入开关（真实环境可由介质错误驱动） */
let writeFailures = 0;
export function setWriteFailures(n: number) {
  writeFailures = Math.max(0, n);
}
export function getWriteFailures() {
  return writeFailures;
}

export class DiskWriteError extends Error {
  constructor(key: string) {
    super(`写盘失败：${key}`);
    this.name = "DiskWriteError";
  }
}

export class CorruptPackageError extends Error {
  constructor(source: string) {
    super(`离线包损坏：${source}`);
    this.name = "CorruptPackageError";
  }
}

export const storageKeys = {
  devices: () => PREFIX + "devices",
  currentDevice: () => PREFIX + "current-device",
  online: () => PREFIX + "online",
  // 每台设备自己的连续记录号
  seq: (deviceId: string) => PREFIX + `seq.${deviceId}`,
  // 本机未确认的记录包
  pending: (deviceId: string, id: string) => PREFIX + `pending.${deviceId}.${id}`,
  pendingIndex: (deviceId: string) => PREFIX + `pending-index.${deviceId}`,
  // 本机已确认、待同步的记录包
  confirmed: (deviceId: string, id: string) => PREFIX + `confirmed.${deviceId}.${id}`,
  confirmedIndex: (deviceId: string) => PREFIX + `confirmed-index.${deviceId}`,
  // 网络恢复后工单服务器（所有设备可见）
  serverBatch: (id: string) => PREFIX + `server.batch.${id}`,
  serverIndex: () => PREFIX + "server.index",
  report: (maintenanceId: string) => PREFIX + `report.${maintenanceId}`,
};

function rawGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function rawSet(key: string, value: string): void {
  // 连续记录号计数器是续作正确性的根基，不参与写盘故障注入
  if (writeFailures > 0 && !key.includes(".seq.")) {
    writeFailures -= 1;
    throw new DiskWriteError(key);
  }
  localStorage.setItem(key, value);
}

/** 写入一条带校验和的记录；失败抛出 DiskWriteError，调用方保留在内存中 */
export function putEnvelope<T>(key: string, id: string, payload: T): void {
  const json = JSON.stringify(payload);
  const envelope: StoredEnvelope<T> = {
    id,
    payload,
    checksum: checksum(id + "|" + json),
    writtenAt: Date.now(),
  };
  rawSet(key, JSON.stringify(envelope));
}

/** 读取并校验；损坏返回 null（坏条目被隔离，其余记录仍可读） */
export function getEnvelope<T>(key: string): T | null {
  const raw = rawGet(key);
  if (!raw) return null;
  try {
    const env = JSON.parse(raw) as StoredEnvelope<T>;
    const json = JSON.stringify(env.payload);
    if (!env.id || env.checksum !== checksum(env.id + "|" + json)) {
      return null;
    }
    return env.payload;
  } catch {
    return null;
  }
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 忽略删除失败 */
  }
}

/** 读取一个「索引 -> 分区记录」集合；坏条目跳过并回报 */
export function readPartition<T>(
  indexKey: string,
  keyOf: (id: string) => string
): { items: T[]; corruptKeys: string[] } {
  let ids: string[] = [];
  const indexRaw = rawGet(indexKey);
  if (indexRaw) {
    try {
      ids = JSON.parse(indexRaw) as string[];
    } catch {
      ids = [];
    }
  }
  const items: T[] = [];
  const corruptKeys: string[] = [];
  for (const id of ids) {
    const item = getEnvelope<T>(keyOf(id));
    if (item === null) corruptKeys.push(keyOf(id));
    else items.push(item);
  }
  return { items, corruptKeys };
}

/**
 * 追加式写入索引（先写数据键、再写索引）。
 * 数据键写失败时直接抛出，索引不变 => 无半截记录。
 */
export function addToIndex(indexKey: string, id: string): void {
  let ids: string[] = [];
  const raw = rawGet(indexKey);
  if (raw) {
    try {
      ids = JSON.parse(raw) as string[];
    } catch {
      ids = [];
    }
  }
  if (!ids.includes(id)) {
    ids.push(id);
    rawSet(indexKey, JSON.stringify(ids));
  }
}

export function removeFromIndex(indexKey: string, id: string): void {
  const raw = rawGet(indexKey);
  if (!raw) return;
  try {
    const ids = (JSON.parse(raw) as string[]).filter((x) => x !== id);
    rawSet(indexKey, JSON.stringify(ids));
  } catch {
    /* 索引损坏时忽略 */
  }
}

export function putPlain<T>(key: string, value: T): void {
  rawSet(key, JSON.stringify(value));
}

export function getPlain<T>(key: string, fallback: T): T {
  const raw = rawGet(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 离线包：导出为带校验和的 JSON 文本（U 盘 / 内网摆渡场景） */
export function exportPackages(batches: unknown[]): string {
  const body = JSON.stringify({ v: 1, batches });
  return JSON.stringify({
    v: 1,
    batches,
    checksum: checksum(body),
    exportedAt: Date.now(),
  });
}

/** 导入离线包并校验；损坏抛 CorruptPackageError，重复批次由调用方按 id 去重 */
export function importPackages(text: string): {
  batches: import("./types").Batch[];
  duplicated: number;
  existingIds: Set<string>;
} {
  let parsed: {
    v?: number;
    batches?: import("./types").Batch[];
    checksum?: string;
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CorruptPackageError("JSON 无法解析");
  }
  if (
    !parsed ||
    parsed.v !== 1 ||
    !Array.isArray(parsed.batches) ||
    typeof parsed.checksum !== "string"
  ) {
    throw new CorruptPackageError("格式不正确");
  }
  const body = JSON.stringify({ v: parsed.v, batches: parsed.batches });
  if (parsed.checksum !== checksum(body)) {
    throw new CorruptPackageError("校验和不一致，内容已被破坏");
  }
  const existing = new Set(getPlain<string[]>(storageKeys.serverIndex(), []));
  let duplicated = 0;
  const batches = parsed.batches.filter((b) => {
    if (!b || typeof b.id !== "string" || typeof b.seq !== "number") {
      throw new CorruptPackageError("存在结构非法的记录");
    }
    if (existing.has(b.id)) {
      duplicated += 1;
      return false;
    }
    return true;
  });
  return { batches, duplicated, existingIds: existing };
}
