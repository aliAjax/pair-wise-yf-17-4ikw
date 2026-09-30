// 领域模型：可续作的现场维护工单
//
// 离线约束：
// - 每台设备（技师记录台）有独立的设备序号 deviceId
// - 每台设备维护一条连续记录号 seq，从 1 开始，任何会话内不回退、不跳号
// - 每笔修改是一个 Batch（记录包），含设备序号 + 连续记录号 + 版本向量
// - 网络恢复后按「音管 + 字段」做合并；同一字段两边都改过则两个版本同时保留为冲突

export type PipeField = "pitch" | "cent" | "reed" | "note";
export const PIPE_FIELDS: PipeField[] = ["pitch", "cent", "reed", "note"];
export const FIELD_LABEL: Record<PipeField, string> = {
  pitch: "音高",
  cent: "音分偏差",
  reed: "簧片状态",
  note: "维修备注",
};

/** 版本向量：deviceId -> 该设备已纳入的最大连续记录号 */
export type VersionVector = Record<string, number>;

export interface PipeEntryData {
  kind: "pipe";
  pipeId: string; // 音管编号，合并主键的一部分
  stopId: string; // 所属音栓
  field: PipeField; // 字段，合并主键的另一部分
  value: string;
}

export interface AbnormalEntryData {
  kind: "abnormal";
  pipeId: string;
  stopId: string;
  abnormal: boolean;
  reason?: string;
}

export interface StopEntryData {
  kind: "stop";
  stopId: string;
  name?: string;
  category?: string;
  /** 复检完成标记：音栓复检完成后，关联异常音管才允许解除 */
  recheckDone?: boolean;
}

export interface ClimateEntryData {
  kind: "climate";
  /** 测量时间戳（毫秒），同设备取 seq 更大者，跨设备并发取时间更晚者 */
  at: number;
  temperature: number; // 摄氏度
  humidity: number; // 相对湿度 %
  note?: string;
}

export type EntryData =
  | PipeEntryData
  | AbnormalEntryData
  | StopEntryData
  | ClimateEntryData;

export interface Entry {
  deviceId: string;
  seq: number;
  at: number;
  data: EntryData;
}

/**
 * 一笔修改记录（一个提交单元）。
 * id 由设备在首次写入前生成，是「重复提交不重复计数」的幂等键。
 */
export interface Batch {
  id: string;
  maintenanceId: string; // 工单编号（单次维护）
  deviceId: string; // 设备序号
  tech: string; // 技师姓名
  seq: number; // 连续记录号
  at: number; // 创建时间
  /** 生成该包时设备已知的版本向量 */
  vv: VersionVector;
  /** 记录音分偏差时的温湿度快照——偏差结论与气候绑定 */
  climate?: { temperature: number; humidity: number; at: number };
  entries: EntryData[];
  /** 已确认（技师在记录台上确认过）：未确认不能进入单次维护报告 */
  confirmed: boolean;
  /** 已在网络恢复后并入工单（对所有设备可见） */
  committed: boolean;
  /** 冲突裁决：两名技师同字段各改一版后，选定生效版本（随包同步、幂等） */
  resolution?: Omit<Resolution, "deviceId" | "seq" | "at">;
}

/** 冲突裁决：保留两版的同时，技师可选定生效版本；裁决本身也走设备序号+记录号 */
export interface Resolution {
  deviceId: string;
  seq: number;
  at: number;
  pipeId: string;
  field: PipeField;
  /** 被选中版本的 (deviceId, seq)，形如 "ST-A#7" */
  chosenVersion: string;
  /** 裁决所基于的版本向量 */
  basis: VersionVector;
}

/** 单次维护报告快照。报告是「快照」，气候失效后旧报告保留但标记为需重算 */
export interface ReportSnapshot {
  maintenanceId: string;
  generatedAt: number;
  generatedBy: string;
  deviceId: string;
  /** 生成时已确认记录包的 id 集合 */
  basedOnBatchIds: string[];
  /** 生成时的内容签名；气候或记录变化使签名失效时旧报告需重算 */
  signature: string;
  abnormalCount: number;
  overLimitCount: number;
  pipeCount: number;
  stopCount: number;
  temperature: number | null;
  humidity: number | null;
  note: string;
}

export interface DeviceInfo {
  id: string;
  tech: string;
}

export const versionKey = (deviceId: string, seq: number): string =>
  `${deviceId}#${seq}`;

/** 比较两个版本向量：a 是否严格发生在 b 之后（a >= b 且至少一个分量更大） */
export function vvDominates(a: VersionVector, b: VersionVector): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let greater = false;
  for (const k of keys) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    if (av < bv) return false;
    if (av > bv) greater = true;
  }
  return greater;
}

/** 版本向量是否不可比较（分叉）：两边都有对方没见过的修改 => 并发 => 冲突 */
export function vvConcurrent(a: VersionVector, b: VersionVector): boolean {
  if (vvDominates(a, b) || vvDominates(b, a)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    if (av !== bv) return true; // 真分叉（全等则同版本，不算并发）
  }
  return false;
}

export function vvMerge(a: VersionVector, b: VersionVector): VersionVector {
  const out: VersionVector = { ...a };
  for (const k of Object.keys(b)) out[k] = Math.max(out[k] ?? 0, b[k]);
  return out;
}
