import { useSyncExternalStore } from "react";
import type {
  Conclusion,
  DeviceInfo,
  EnvRecord,
  FieldMergeState,
  FieldStatus,
  MaintenanceReport,
  Op,
  OpKind,
  PipeState,
  PipeStatus,
  Reinspection,
  State,
} from "./types";
import { adjustedCent, centStatus, REF_HUMIDITY, REF_TEMP } from "./tuning";

const STORAGE_KEY = "organ-maintenance-state-v1";
const BACKUP_KEY = "organ-maintenance-backup-v1";

// ---------- 工具 ----------

export function stopKeyOf(venue: string, stopName: string): string {
  return `${venue}||${stopName}`;
}

export function pipeKeyOf(venue: string, stopName: string, pipeId: string): string {
  return `${venue}||${stopName}||${pipeId}`;
}

/** 音管字段的展示值：已确认 > 已裁决 > 待确认最新版 */
export function fieldValue(pipe: PipeState, field: string): string | undefined {
  const fs = pipe.fields[field];
  if (!fs) return undefined;
  if (fs.status === "confirmed") return fs.confirmedValue;
  if (fs.status === "resolved") return fs.resolvedValue;
  if (fs.versions.length) return fs.versions[fs.versions.length - 1].value;
  return fs.confirmedValue;
}

export function pipeStatusOf(pipe: PipeState): PipeStatus {
  let status: PipeStatus = "confirmed";
  for (const fs of Object.values(pipe.fields)) {
    if (!fs) continue;
    if (fs.status === "conflict") return "conflict";
    if (fs.status === "pending" || fs.status === "resolved") status = "pending";
  }
  return status;
}

export function deviceName(state: State, deviceId: string): string {
  return state.devices.find((d) => d.id === deviceId)?.name ?? deviceId.slice(0, 6);
}

function checksum(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h);
}

// ---------- 持久化（带校验和 + 双包备份） ----------

function persistState(state: State, failArmed: boolean): boolean {
  if (failArmed) return false; // 模拟写盘失败
  try {
    const data = JSON.stringify(state);
    const pkg = JSON.stringify({ data, cs: checksum(data) });
    localStorage.setItem(STORAGE_KEY, pkg);
    localStorage.setItem(BACKUP_KEY, pkg); // 上一个完整包始终可读
    return true;
  } catch {
    return false;
  }
}

function normalize(state: State): State {
  state.online = state.online ?? true;
  state.outbox = state.outbox ?? [];
  state.appliedOpIds = state.appliedOpIds ?? [];
  state.seqByDevice = state.seqByDevice ?? {};
  state.devices = state.devices ?? [];
  state.pipes = state.pipes ?? {};
  state.envRecords = state.envRecords ?? [];
  state.reinspections = state.reinspections ?? [];
  state.reports = state.reports ?? [];
  state.latestEnvByVenue = state.latestEnvByVenue ?? {};
  state.maintenanceCount = state.maintenanceCount ?? 0;
  return state;
}

function freshState(): State {
  const id = "dev-" + Math.random().toString(36).slice(2, 8);
  return {
    devices: [{ id, name: "技师A" }],
    activeDeviceId: id,
    seqByDevice: { [id]: 0 },
    pipes: {},
    envRecords: [],
    reinspections: [],
    reports: [],
    outbox: [],
    appliedOpIds: [],
    latestEnvByVenue: {},
    maintenanceCount: 0,
    online: true,
  };
}

/** 首次使用时播种一份已确认的演示数据 */
function seedState(): State {
  const s = freshState();
  const venue = "St.Mary's Church";
  const envId = "env-seed-1";
  const now = Date.now() - 86_400_000;
  s.envRecords = [
    { id: envId, venue, temp: 18, humidity: 55, ts: now, deviceId: s.activeDeviceId, seq: 1 },
  ];
  s.latestEnvByVenue[venue] = envId;

  const rows: Array<[string, string, string, string, string, string, string, string]> = [
    ["Trumpet 8'", "簧片音栓", "C#4", "C#4", "9", "簧片需微调", "簧片需微调", "false"],
    ["Principal 4'", "主音栓", "G3", "G3", "-3", "正常", "", "false"],
    ["Bourdon 16'", "低音管", "F2", "F2", "-12", "标记复检", "音管偏低，标记复检", "true"],
  ];
  for (const [stopName, stopType, pipeId, pitch, cent, reed, note, abnormal] of rows) {
    const key = pipeKeyOf(venue, stopName, pipeId);
    const fields: Record<string, FieldMergeState> = {};
    for (const [f, v] of [
      ["pitch", pitch],
      ["cent", cent],
      ["reed", reed],
      ["note", note],
      ["abnormal", abnormal],
    ] as Array<[string, string]>) {
      fields[f] = { status: "confirmed", confirmedValue: v, versions: [] };
    }
    s.pipes[key] = {
      id: key,
      stopKey: stopKeyOf(venue, stopName),
      venue,
      stopName,
      stopType,
      fields,
      status: "confirmed",
      createdAt: now,
      createdBy: s.activeDeviceId,
    };
  }
  s.reinspections = [
    {
      id: "reinspect-seed-1",
      stopKey: stopKeyOf(venue, "Trumpet 8'"),
      result: "复检合格",
      ts: now,
      deviceId: s.activeDeviceId,
      seq: 2,
    },
  ];
  const conclusions = computeConclusions(s, venue, s.envRecords[0]);
  s.reports = [
    {
      id: "report-seed-1",
      venue,
      title: "首次调音报告",
      createdAt: now,
      createdBy: s.activeDeviceId,
      envSnapshotId: envId,
      envSnapshot: { temp: 18, humidity: 55 },
      conclusions,
      stale: false,
    },
  ];
  s.maintenanceCount = 1;
  s.appliedOpIds = ["seed"];
  return s;
}

export function loadState(): { state: State; pkgStatus: string } {
  for (const [key, status] of [
    [STORAGE_KEY, "完整"],
    [BACKUP_KEY, "备份恢复"],
  ] as const) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      const pkg = JSON.parse(raw);
      if (pkg && typeof pkg.data === "string" && checksum(pkg.data) === pkg.cs) {
        return { state: normalize(JSON.parse(pkg.data) as State), pkgStatus: status };
      }
    } catch {
      // 包损坏，尝试下一个
    }
  }
  const seeded = seedState();
  persistState(seeded, false);
  return { state: seeded, pkgStatus: "完整" };
}

// ---------- 合并引擎 ----------

function computeConclusions(s: State, venue: string, env?: EnvRecord): Conclusion[] {
  const out: Conclusion[] = [];
  for (const pipe of Object.values(s.pipes)) {
    if (pipe.venue !== venue) continue;
    const centStr = fieldValue(pipe, "cent");
    if (centStr === undefined || centStr.trim() === "") continue;
    const cent = Number(centStr);
    if (Number.isNaN(cent)) continue;
    const temp = env ? env.temp : REF_TEMP;
    const humidity = env ? env.humidity : REF_HUMIDITY;
    const adjusted = adjustedCent(cent, temp, humidity);
    out.push({ pipeId: pipe.id, cent, adjustedCent: adjusted, status: centStatus(adjusted) });
  }
  return out;
}

/** 应用离线工单，生成新状态（纯函数；opId 幂等去重） */
function applyOutbox(state: State): State {
  const s: State = structuredClone(state);
  s.outbox = [];
  for (const op of state.outbox) {
    if (s.appliedOpIds.includes(op.opId)) continue; // 重复提交不生效
    s.appliedOpIds.push(op.opId);
    switch (op.kind) {
      case "pipe": {
        if (op.pipeId && !s.pipes[op.pipeId]) {
          s.pipes[op.pipeId] = {
            id: op.pipeId,
            stopKey: op.stopKey ?? "",
            venue: op.venue ?? "",
            stopName: op.stopName ?? "",
            stopType: op.stopType ?? "",
            fields: {},
            status: "confirmed",
            createdAt: op.ts,
            createdBy: op.deviceId,
          };
        }
        break;
      }
      case "field": {
        const pipe = op.pipeId ? s.pipes[op.pipeId] : undefined;
        if (!pipe || !op.field) break;
        const fs: FieldMergeState = pipe.fields[op.field]
          ? structuredClone(pipe.fields[op.field]!)
          : { status: "confirmed", versions: [] };
        const idx = fs.versions.findIndex((v) => v.deviceId === op.deviceId);
        const v = { opId: op.opId, deviceId: op.deviceId, seq: op.seq, value: op.value ?? "", ts: op.ts };
        if (idx >= 0) fs.versions[idx] = v;
        else fs.versions.push(v);
        fs.versions.sort((a, b) => a.seq - b.seq);
        // 同一字段两边都改过 → 冲突，保留两版
        fs.status = fs.versions.length >= 2 ? "conflict" : "pending";
        pipe.fields[op.field] = fs;
        break;
      }
      case "env": {
        if (!op.env || !op.venue) break;
        const rec: EnvRecord = {
          id: op.opId,
          venue: op.venue,
          temp: op.env.temp,
          humidity: op.env.humidity,
          ts: op.ts,
          deviceId: op.deviceId,
          seq: op.seq,
        };
        s.envRecords.push(rec);
        s.latestEnvByVenue[op.venue] = rec.id;
        // 温湿度变化 → 旧偏差结论失效
        for (const r of s.reports) {
          if (r.venue === op.venue && r.envSnapshotId !== rec.id) r.stale = true;
        }
        break;
      }
      case "reinspect": {
        s.reinspections.push({
          id: op.opId,
          stopKey: op.stopKey ?? "",
          result: op.result ?? "",
          ts: op.ts,
          deviceId: op.deviceId,
          seq: op.seq,
        });
        break;
      }
      case "report": {
        if (!op.venue || !op.title) break;
        const envId = s.latestEnvByVenue[op.venue];
        const envRec = s.envRecords.find((e) => e.id === envId);
        s.reports.push({
          id: op.opId,
          venue: op.venue,
          title: op.title,
          createdAt: op.ts,
          createdBy: op.deviceId,
          envSnapshotId: envId,
          envSnapshot: envRec ? { temp: envRec.temp, humidity: envRec.humidity } : undefined,
          conclusions: computeConclusions(s, op.venue, envRec),
          stale: false,
        });
        s.maintenanceCount += 1; // 幂等：同一 opId 重放不会重复增加
        break;
      }
    }
  }
  for (const p of Object.values(s.pipes)) p.status = pipeStatusOf(p);
  return s;
}

// ---------- 存储类 ----------

class Store {
  state: State;
  pkgStatus: string;
  writeFailArmed = false;
  lastPersistFailed = false;
  private listeners = new Set<() => void>();
  /** 批量生成 op 时的草稿序号（避免同一批 op 记录号相同） */
  private seqDraft: Record<string, number> = {};

  constructor() {
    const loaded = loadState();
    this.state = loaded.state;
    this.pkgStatus = loaded.pkgStatus;
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  private emit() {
    this.listeners.forEach((l) => l());
  }

  /** 本地变更：先更新内存，再尝试落盘；写盘失败时保留内存与离线工单，可重新提交 */
  private commit(next: State) {
    const ok = persistState(next, this.writeFailArmed);
    if (this.writeFailArmed) this.writeFailArmed = false;
    this.lastPersistFailed = !ok;
    this.state = next;
    this.emit();
  }

  /** 合并提交：落盘成功才清空离线工单；失败则工单原样保留，可重新提交 */
  private commitMerge(candidate: State) {
    const ok = persistState(candidate, this.writeFailArmed);
    if (this.writeFailArmed) this.writeFailArmed = false;
    this.lastPersistFailed = !ok;
    if (ok) this.state = candidate;
    this.emit();
  }

  private nextOp(kind: OpKind, extra: Partial<Op>): Op {
    const deviceId = this.state.activeDeviceId;
    if (!(deviceId in this.seqDraft)) this.seqDraft[deviceId] = this.state.seqByDevice[deviceId] ?? 0;
    const seq = this.seqDraft[deviceId] + 1;
    this.seqDraft[deviceId] = seq;
    return {
      opId: `${deviceId}:${seq}`,
      deviceId,
      seq,
      ts: Date.now(),
      kind,
      ...extra,
    };
  }

  private pushOps(ops: Op[]) {
    const seqByDevice = { ...this.state.seqByDevice, ...this.seqDraft };
    // 同一 opId 不重复入工单
    const existing = new Set(this.state.outbox.map((o) => o.opId));
    const outbox = [...this.state.outbox];
    for (const op of ops) if (!existing.has(op.opId)) outbox.push(op);
    this.commit({ ...this.state, outbox, seqByDevice });
  }

  // ---- 设备 ----

  addDevice() {
    const n = this.state.devices.length;
    const id = "dev-" + Math.random().toString(36).slice(2, 8);
    const devices = [...this.state.devices, { id, name: `技师${String.fromCharCode(65 + n)}` }];
    this.commit({
      ...this.state,
      devices,
      activeDeviceId: id,
      seqByDevice: { ...this.state.seqByDevice, [id]: 0 },
    });
  }

  setActiveDevice(id: string) {
    this.commit({ ...this.state, activeDeviceId: id });
  }

  setOnline(online: boolean) {
    this.commit({ ...this.state, online });
  }

  armWriteFail() {
    this.writeFailArmed = true;
    this.emit();
  }

  corruptPackage() {
    try {
      localStorage.setItem(STORAGE_KEY, '{"data":"corrupted","cs":"0"}');
    } catch {
      /* ignore */
    }
    location.reload();
  }

  // ---- 记录台：保存一条音管维护记录 ----

  saveRecord(input: {
    venue: string;
    stopName: string;
    stopType: string;
    pipeId: string;
    pitch: string;
    cent: string;
    reed: string;
    note: string;
    abnormal: boolean;
    temp: string;
    humidity: string;
  }): { ok: boolean; reason?: string } {
    const venue = input.venue.trim();
    const stopName = input.stopName.trim();
    const pipeId = input.pipeId.trim();
    if (!venue || !stopName || !pipeId) {
      return { ok: false, reason: "场馆、音栓、音管编号为必填项" };
    }
    const ops: Op[] = [];
    const key = pipeKeyOf(venue, stopName, pipeId);
    const stopKey = stopKeyOf(venue, stopName);
    const pipeExists = !!this.state.pipes[key] || this.state.outbox.some((o) => o.kind === "pipe" && o.pipeId === key);
    if (!pipeExists) {
      ops.push(
        this.nextOp("pipe", {
          pipeId: key,
          stopKey,
          venue,
          stopName,
          stopType: input.stopType,
        })
      );
    }
    const fields: Array<[string, string]> = [
      ["pitch", input.pitch.trim()],
      ["cent", input.cent.trim()],
      ["reed", input.reed.trim()],
      ["note", input.note.trim()],
    ];
    for (const [f, v] of fields) {
      if (v !== "") ops.push(this.nextOp("field", { pipeId: key, field: f, value: v }));
    }
    if (input.abnormal) ops.push(this.nextOp("field", { pipeId: key, field: "abnormal", value: "true" }));
    if (input.temp.trim() !== "" && input.humidity.trim() !== "") {
      const temp = Number(input.temp);
      const humidity = Number(input.humidity);
      if (!Number.isNaN(temp) && !Number.isNaN(humidity)) {
        ops.push(this.nextOp("env", { venue, env: { temp, humidity } }));
      }
    }
    this.pushOps(ops);
    return { ok: true };
  }

  // ---- 温湿度记录 ----

  saveEnv(input: { venue: string; temp: number; humidity: number }) {
    const op = this.nextOp("env", { venue: input.venue, env: { temp: input.temp, humidity: input.humidity } });
    this.pushOps([op]);
  }

  // ---- 音栓复检 ----

  reinspect(stopKey: string, result: string) {
    const op = this.nextOp("reinspect", { stopKey, result });
    this.pushOps([op]);
  }

  // ---- 异常音管解除：复检未完成则联动拦截 ----

  releasePipe(pipeId: string): { ok: boolean; reason?: string } {
    const pipe = this.state.pipes[pipeId];
    if (!pipe) return { ok: false, reason: "音管不存在" };
    const merged = this.state.reinspections.some((r) => r.stopKey === pipe.stopKey);
    const pending = this.state.outbox.some((o) => o.kind === "reinspect" && o.stopKey === pipe.stopKey);
    if (!merged && !pending) {
      return { ok: false, reason: "音栓复检未完成，关联异常音管不能解除" };
    }
    if (!merged && pending) {
      return { ok: false, reason: "复检记录尚在离线工单中，网络合并后才能解除" };
    }
    const op = this.nextOp("field", { pipeId, field: "abnormal", value: "false" });
    this.pushOps([op]);
    return { ok: true };
  }

  // ---- 冲突裁决与确认 ----

  resolveField(pipeId: string, field: string, opId: string) {
    const s: State = structuredClone(this.state);
    const fs = s.pipes[pipeId]?.fields[field];
    if (!fs) return;
    const v = fs.versions.find((x) => x.opId === opId);
    if (!v) return;
    fs.resolvedValue = v.value;
    fs.resolvedOpId = opId;
    fs.status = "resolved";
    s.pipes[pipeId].status = pipeStatusOf(s.pipes[pipeId]);
    this.commit(s);
  }

  confirmPipe(pipeId: string) {
    const s: State = structuredClone(this.state);
    const pipe = s.pipes[pipeId];
    if (!pipe) return;
    for (const [field, fs] of Object.entries(pipe.fields)) {
      if (!fs) continue;
      if (fs.status === "conflict") continue; // 冲突未裁决不能确认
      if (fs.status === "resolved") {
        fs.confirmedValue = fs.resolvedValue;
        fs.versions = [];
        fs.status = "confirmed";
      } else if (fs.status === "pending") {
        const v = fs.versions[fs.versions.length - 1];
        fs.confirmedValue = v.value;
        fs.versions = [];
        fs.status = "confirmed";
      }
    }
    pipe.status = pipeStatusOf(pipe);
    this.commit(s);
  }

  confirmAll() {
    const s: State = structuredClone(this.state);
    for (const pipe of Object.values(s.pipes)) {
      for (const fs of Object.values(pipe.fields)) {
        if (!fs) continue;
        if (fs.status === "conflict") continue;
        if (fs.status === "resolved") {
          fs.confirmedValue = fs.resolvedValue;
          fs.versions = [];
          fs.status = "confirmed";
        } else if (fs.status === "pending") {
          const v = fs.versions[fs.versions.length - 1];
          fs.confirmedValue = v.value;
          fs.versions = [];
          fs.status = "confirmed";
        }
      }
      pipe.status = pipeStatusOf(pipe);
    }
    this.commit(s);
  }

  // ---- 单次维护报告：未确认不能生成 ----

  createReport(venue: string, title: string): { ok: boolean; reason?: string; blocked?: string[] } {
    const blocked = Object.values(this.state.pipes)
      .filter((p) => p.venue === venue && p.status !== "confirmed")
      .map((p) => p.id.split("||")[2]);
    if (blocked.length) {
      return { ok: false, reason: "有音管尚未确认，不能进入单次维护报告", blocked };
    }
    const dup = this.state.outbox.some((o) => o.kind === "report" && o.venue === venue && o.title === title);
    if (dup) return { ok: false, reason: "该报告已在离线工单中，合并后即可生成" };
    const op = this.nextOp("report", { venue, title });
    this.pushOps([op]);
    return { ok: true };
  }

  recalcReport(reportId: string) {
    const s: State = structuredClone(this.state);
    const report = s.reports.find((r) => r.id === reportId);
    if (!report) return;
    const envId = s.latestEnvByVenue[report.venue];
    const envRec = s.envRecords.find((e) => e.id === envId);
    report.conclusions = computeConclusions(s, report.venue, envRec);
    report.envSnapshotId = envId;
    report.envSnapshot = envRec ? { temp: envRec.temp, humidity: envRec.humidity } : undefined;
    report.stale = false;
    this.commit(s);
  }

  recalcAll(venue: string) {
    const s: State = structuredClone(this.state);
    const envId = s.latestEnvByVenue[venue];
    const envRec = s.envRecords.find((e) => e.id === envId);
    for (const report of s.reports) {
      if (report.venue !== venue) continue;
      report.conclusions = computeConclusions(s, report.venue, envRec);
      report.envSnapshotId = envId;
      report.envSnapshot = envRec ? { temp: envRec.temp, humidity: envRec.humidity } : undefined;
      report.stale = false;
    }
    this.commit(s);
  }

  // ---- 网络恢复：合并离线工单（失败可重新提交） ----

  mergeOutbox() {
    if (!this.state.outbox.length) return;
    const candidate = applyOutbox(this.state);
    this.commitMerge(candidate);
  }
}

export const store = new Store();

export function useStore() {
  const state = useSyncExternalStore(store.subscribe, () => store.state);
  return { state, store };
}

export type { DeviceInfo, FieldStatus, MaintenanceReport };
