// 管风琴维护记录台 —— 核心类型定义

/** 字段合并状态：已确认 / 待确认（单端改过） / 冲突（两端都改过，保留两版） / 已裁决待确认 */
export type FieldStatus = "confirmed" | "pending" | "conflict" | "resolved";

export interface PendingVersion {
  opId: string;
  deviceId: string;
  seq: number;
  value: string;
  ts: number;
}

export interface FieldMergeState {
  /** 已确认的值 */
  confirmedValue?: string;
  /** 冲突裁决后选定的值（仍需整管确认） */
  resolvedValue?: string;
  resolvedOpId?: string;
  status: FieldStatus;
  /** 自上次确认以来，各设备提交过的版本（按设备保留最新一版） */
  versions: PendingVersion[];
}

export type PipeStatus = "confirmed" | "pending" | "conflict";

export interface PipeState {
  /** 音管标识：场馆 || 音栓 || 音管编号 */
  id: string;
  stopKey: string;
  venue: string;
  stopName: string;
  stopType: string;
  fields: Partial<Record<string, FieldMergeState>>;
  status: PipeStatus;
  createdAt: number;
  createdBy: string;
}

export interface EnvRecord {
  id: string;
  venue: string;
  temp: number;
  humidity: number;
  ts: number;
  deviceId: string;
  seq: number;
}

export interface Reinspection {
  id: string;
  stopKey: string;
  result: string;
  ts: number;
  deviceId: string;
  seq: number;
}

export interface Conclusion {
  pipeId: string;
  cent: number;
  adjustedCent: number;
  status: "正常" | "偏差超限";
}

export interface MaintenanceReport {
  id: string;
  venue: string;
  title: string;
  createdAt: number;
  createdBy: string;
  envSnapshotId?: string;
  envSnapshot?: { temp: number; humidity: number };
  conclusions: Conclusion[];
  /** 温湿度在报告生成后发生变化 → 结论失效，需重算 */
  stale: boolean;
}

export type OpKind = "pipe" | "field" | "env" | "reinspect" | "report";

/** 一笔修改：带设备序号与该设备上连续的记录号 */
export interface Op {
  opId: string; // `${deviceId}:${seq}`
  deviceId: string;
  seq: number;
  ts: number;
  kind: OpKind;
  pipeId?: string;
  stopKey?: string;
  venue?: string;
  field?: string;
  value?: string;
  stopName?: string;
  stopType?: string;
  env?: { temp: number; humidity: number };
  result?: string;
  title?: string;
}

export interface DeviceInfo {
  id: string;
  name: string;
}

export interface State {
  devices: DeviceInfo[];
  activeDeviceId: string;
  /** 每台设备各自连续递增的记录号 */
  seqByDevice: Record<string, number>;
  pipes: Record<string, PipeState>;
  envRecords: EnvRecord[];
  reinspections: Reinspection[];
  reports: MaintenanceReport[];
  /** 离线工单：已生成、尚未合并提交的修改 */
  outbox: Op[];
  /** 已应用的 opId（幂等去重，重复提交不重复生效） */
  appliedOpIds: string[];
  latestEnvByVenue: Record<string, string>;
  /** 维护次数：每确认一份单次维护报告 +1，重复提交不重复增加 */
  maintenanceCount: number;
  online: boolean;
}
