import {
  Batch,
  DeviceInfo,
  EntryData,
  PipeField,
  ReportSnapshot,
  Resolution,
  VersionVector,
  vvMerge,
} from "./types";
import { mergeBatches, MergeResult, reportSignature, climateStale } from "./merge";
import {
  addToIndex,
  CorruptPackageError,
  DiskWriteError,
  exportPackages,
  getEnvelope,
  getPlain,
  importPackages,
  putEnvelope,
  putPlain,
  readPartition,
  removeFromIndex,
  removeKey,
  setWriteFailures,
  storageKeys,
} from "./storage";

const MAINTENANCE_ID = "WO-2026-StMary";

interface StoreState {
  ready: boolean;
  devices: DeviceInfo[];
  currentDeviceId: string;
  online: boolean;
  drafts: Batch[]; // 未确认（本机）
  memoryOnly: Set<string>; // 写盘失败、仅存内存的批次 id
  localConfirmed: Batch[]; // 本机已确认待同步
  serverBatches: Batch[]; // 工单服务器（网络恢复后所有设备可见）
  reports: ReportSnapshot[];
  corruptKeys: string[];
  notices: { id: number; kind: "ok" | "warn" | "err"; text: string }[];
  lastSyncAt: number | null;
  rejectedDuplicates: number;
}

type Listener = () => void;

function uid(seed: string): string {
  return seed + "-" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

class MaintenanceStore {
  state: StoreState = {
    ready: false,
    devices: [],
    currentDeviceId: "",
    online: false,
    drafts: [],
    memoryOnly: new Set(),
    localConfirmed: [],
    serverBatches: [],
    reports: [],
    corruptKeys: [],
    notices: [],
    lastSyncAt: null,
    rejectedDuplicates: 0,
  };
  private listeners = new Set<Listener>();
  private noticeSeq = 1;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit() {
    for (const fn of this.listeners) fn();
  }

  private patch(p: Partial<StoreState>) {
    this.state = { ...this.state, ...p };
    this.emit();
  }

  notify(kind: "ok" | "warn" | "err", text: string) {
    const notice = { id: this.noticeSeq++, kind, text };
    this.patch({ notices: [...this.state.notices, notice].slice(-8) });
  }

  clearNotices() {
    this.patch({ notices: [] });
  }

  // ───────────────────────── 初始化与种子数据 ─────────────────────────

  init() {
    if (this.state.ready) return;
    if (!getPlain<string[] | null>(storageKeys.devices(), null)) {
      this.seed();
    }
    const devices = getPlain<DeviceInfo[]>(storageKeys.devices(), []);
    const currentDeviceId = getPlain<string>(
      storageKeys.currentDevice(),
      devices[0]?.id ?? ""
    );
    const online = getPlain<boolean>(storageKeys.online(), false);
    this.patch({ devices, currentDeviceId, online, ready: true });
    this.reloadAll();
  }

  private seed() {
    const devices: DeviceInfo[] = [
      { id: "ST-A", tech: "陈技师" },
      { id: "ST-B", tech: "林技师" },
    ];
    putPlain(storageKeys.devices(), devices);
    putPlain(storageKeys.currentDevice(), "ST-A");
    const t0 = Date.now() - 1000 * 60 * 60 * 26;
    const mk = (
      deviceId: string,
      tech: string,
      seq: number,
      minutesAgo: number,
      entries: EntryData[],
      vv: VersionVector,
      climate?: Batch["climate"]
    ): Batch => ({
      id: `seed-${deviceId}-${seq}`,
      maintenanceId: MAINTENANCE_ID,
      deviceId,
      tech,
      seq,
      at: t0 + minutesAgo * 60_000,
      vv,
      climate,
      entries,
      confirmed: true,
      committed: true,
    });

    const seedBatches: Batch[] = [
      mk("ST-A", "陈技师", 1, 1500, [
        { kind: "stop", stopId: "trumpet-8", name: "Trumpet 8'", category: "簧片音栓" },
        { kind: "stop", stopId: "principal-4", name: "Principal 4'", category: "主音栓" },
        { kind: "stop", stopId: "bourdon-16", name: "Bourdon 16'", category: "低音管" },
        {
          kind: "climate",
          at: t0 + 1500 * 60_000,
          temperature: 19.5,
          humidity: 42,
          note: "上午开管前基线",
        },
      ], {}),
      mk(
        "ST-A",
        "陈技师",
        2,
        1420,
        [
          { kind: "pipe", pipeId: "TP-Cs4", stopId: "trumpet-8", field: "pitch", value: "C#4" },
          { kind: "pipe", pipeId: "TP-Cs4", stopId: "trumpet-8", field: "cent", value: "+9" },
          { kind: "pipe", pipeId: "TP-Cs4", stopId: "trumpet-8", field: "reed", value: "簧片需微调" },
          { kind: "pipe", pipeId: "PR-G3", stopId: "principal-4", field: "pitch", value: "G3" },
          { kind: "pipe", pipeId: "PR-G3", stopId: "principal-4", field: "cent", value: "-3" },
          { kind: "pipe", pipeId: "BD-F2", stopId: "bourdon-16", field: "pitch", value: "F2" },
          { kind: "pipe", pipeId: "BD-F2", stopId: "bourdon-16", field: "cent", value: "-12" },
          { kind: "abnormal", pipeId: "BD-F2", stopId: "bourdon-16", abnormal: true, reason: "偏差超限，标记复检" },
        ],
        { "ST-A": 1 },
        { temperature: 19.5, humidity: 42, at: t0 + 1420 * 60_000 }
      ),
      mk(
        "ST-B",
        "林技师",
        1,
        1400,
        [
          { kind: "pipe", pipeId: "TP-Cs4", stopId: "trumpet-8", field: "note", value: "簧片座有轻微磨损" },
          { kind: "pipe", pipeId: "PR-G3", stopId: "principal-4", field: "note", value: "正常" },
        ],
        { "ST-A": 2 }
      ),
    ];

    for (const b of seedBatches) {
      putEnvelope(storageKeys.serverBatch(b.id), b.id, b);
      addToIndex(storageKeys.serverIndex(), b.id);
    }
    putPlain(storageKeys.seq("ST-A"), 2);
    putPlain(storageKeys.seq("ST-B"), 1);
    putPlain(storageKeys.online(), false);
  }

  // ───────────────────────── 装载 ─────────────────────────

  private reloadAll() {
    const d = this.state.currentDeviceId;
    this.reloadServer();
    this.reloadLocal(d);
  }

  private reloadServer() {
    const { items, corruptKeys } = readPartition<Batch>(
      storageKeys.serverIndex(),
      (id) => storageKeys.serverBatch(id)
    );
    const reports = this.state.reports.length
      ? this.state.reports
      : this.readReports();
    this.patch({
      serverBatches: items.filter((b) => b.maintenanceId === MAINTENANCE_ID),
      corruptKeys: [...new Set([...this.state.corruptKeys, ...corruptKeys])],
      reports,
    });
  }

  private readReports(): ReportSnapshot[] {
    // 报告按 maintenance 单条存储
    const r = getEnvelope<ReportSnapshot>(storageKeys.report(MAINTENANCE_ID));
    return r ? [r] : [];
  }

  private reloadLocal(deviceId: string) {
    const pending = readPartition<Batch>(
      storageKeys.pendingIndex(deviceId),
      (id) => storageKeys.pending(deviceId, id)
    );
    const confirmed = readPartition<Batch>(
      storageKeys.confirmedIndex(deviceId),
      (id) => storageKeys.confirmed(deviceId, id)
    );
    // 内存中未落盘的草稿保留
    const memory = this.state.drafts.filter(
      (b) => this.state.memoryOnly.has(b.id) && b.deviceId === deviceId
    );
    this.patch({
      drafts: [...pending.items, ...memory],
      localConfirmed: confirmed.items,
      corruptKeys: [...new Set([...this.state.corruptKeys, ...pending.corruptKeys, ...confirmed.corruptKeys])],
    });
  }

  /** 测试/外部预置数据后重新装载 */
  reloadFromDisk() {
    const devices = getPlain<DeviceInfo[]>(storageKeys.devices(), []);
    const currentDeviceId = getPlain<string>(
      storageKeys.currentDevice(),
      devices[0]?.id ?? ""
    );
    this.patch({ devices, currentDeviceId });
    this.reloadAll();
  }

  switchDevice(deviceId: string) {
    putPlain(storageKeys.currentDevice(), deviceId);
    this.patch({ currentDeviceId: deviceId, drafts: [], localConfirmed: [] });
    this.reloadLocal(deviceId);
    this.notify("ok", `已切换到记录台 ${deviceId}`);
  }

  setOnline(online: boolean) {
    putPlain(storageKeys.online(), online);
    this.patch({ online });
    if (online) {
      this.notify("ok", "网络已恢复，开始自动合并待同步记录");
      this.sync();
    } else {
      this.notify("warn", "已进入离线现场模式，记录先存本机");
    }
  }

  setFailureInjection(n: number) {
    setWriteFailures(n);
    if (n > 0) this.notify("warn", `已注入 ${n} 次写盘故障，用于演练落盘失败恢复`);
  }

  // ───────────────────────── 连续记录号 ─────────────────────────

  private nextSeq(deviceId: string): number {
    const cur = getPlain<number>(storageKeys.seq(deviceId), 0);
    const next = cur + 1;
    // 序号本身先落盘；即便随后记录写失败，下次重试沿用本批次 id+seq，不产生重复计数
    putPlain(storageKeys.seq(deviceId), next);
    return next;
  }

  currentSeq(): number {
    return getPlain<number>(storageKeys.seq(this.state.currentDeviceId), 0);
  }

  // ───────────────────────── 保存 / 确认 / 重写 ─────────────────────────

  /**
   * 保存一笔修改（一个记录包）。
   * 成功：写入未确认分区；失败（DiskWriteError）：内容留在内存，可重新提交。
   */
  saveDraft(
    tech: string,
    entries: EntryData[],
    resolution?: Batch["resolution"]
  ): { ok: boolean; id?: string } {
    const deviceId = this.state.currentDeviceId;
    if (entries.length === 0 && !resolution) {
      this.notify("warn", "本笔没有任何修改内容");
      return { ok: false };
    }
    const knownVV = this.knownVV();
    const seq = this.nextSeq(deviceId);
    const climateEntry = entries.find((e) => e.kind === "climate");
    const currentClimate = this.merged().climate;
    const climate: Batch["climate"] =
      entries.some((e) => e.kind === "pipe" && e.field === "cent")
        ? climateEntry && climateEntry.kind === "climate"
          ? { temperature: climateEntry.temperature, humidity: climateEntry.humidity, at: climateEntry.at }
          : currentClimate
            ? { temperature: currentClimate.temperature, humidity: currentClimate.humidity, at: currentClimate.at }
            : undefined
        : undefined;

    const batch: Batch = {
      id: uid("B"),
      maintenanceId: MAINTENANCE_ID,
      deviceId,
      tech,
      seq,
      at: Date.now(),
      vv: knownVV,
      climate,
      entries,
      confirmed: false,
      committed: false,
      resolution,
    };

    try {
      putEnvelope(storageKeys.pending(deviceId, batch.id), batch.id, batch);
      addToIndex(storageKeys.pendingIndex(deviceId), batch.id);
      this.patch({ drafts: [...this.state.drafts, batch] });
      this.notify("ok", `记录 ${deviceId}#${seq} 已暂存（未确认，不进入维护报告）`);
      return { ok: true, id: batch.id };
    } catch (e) {
      if (e instanceof DiskWriteError) {
        // 未写入内容保留在内存，可重新提交；seq 已占用但批次 id 不变，重试不会重复计数
        this.patch({
          drafts: [...this.state.drafts, batch],
          memoryOnly: new Set(this.state.memoryOnly).add(batch.id),
        });
        this.notify("err", `记录 ${deviceId}#${seq} 写盘失败，内容暂存内存，请点「重新写入」`);
        return { ok: false, id: batch.id };
      }
      throw e;
    }
  }

  /** 重新提交未落盘内容（同一批次 id + seq，幂等） */
  rewriteDraft(id: string) {
    const b = this.state.drafts.find((x) => x.id === id);
    if (!b) return;
    try {
      putEnvelope(storageKeys.pending(b.deviceId, b.id), b.id, b);
      addToIndex(storageKeys.pendingIndex(b.deviceId), b.id);
      const memoryOnly = new Set(this.state.memoryOnly);
      memoryOnly.delete(id);
      this.patch({ drafts: [...this.state.drafts], memoryOnly });
      this.notify("ok", `记录 ${b.deviceId}#${b.seq} 重新写入成功，维护次数未重复增加`);
    } catch (e) {
      if (e instanceof DiskWriteError) {
        this.notify("err", `记录 ${b.deviceId}#${b.seq} 仍写盘失败，可再次重试`);
      } else throw e;
    }
  }

  /** 确认：未确认 -> 已确认（已确认记录只读）。确认后才有资格进入报告与同步 */
  confirmDraft(id: string) {
    const b = this.state.drafts.find((x) => x.id === id);
    if (!b) return;
    const confirmed: Batch = { ...b, confirmed: true };
    try {
      putEnvelope(storageKeys.confirmed(b.deviceId, b.id), b.id, confirmed);
      addToIndex(storageKeys.confirmedIndex(b.deviceId), b.id);
      removeKey(storageKeys.pending(b.deviceId, b.id));
      removeFromIndex(storageKeys.pendingIndex(b.deviceId), b.id);
      const memoryOnly = new Set(this.state.memoryOnly);
      memoryOnly.delete(b.id);
      this.patch({
        drafts: this.state.drafts.filter((x) => x.id !== id),
        localConfirmed: [...this.state.localConfirmed, confirmed],
        memoryOnly,
      });
      this.notify("ok", `记录 ${b.deviceId}#${b.seq} 已确认${this.state.online ? "，在线立即并入工单" : "，等待网络恢复后续传"}`);
      if (this.state.online) this.sync();
    } catch (e) {
      if (e instanceof DiskWriteError) {
        this.notify("err", "确认写入失败，该记录仍为未确认状态，可重试");
      } else throw e;
    }
  }

  /** 未确认记录允许作废（已确认记录不可改） */
  discardDraft(id: string) {
    const b = this.state.drafts.find((x) => x.id === id);
    if (!b) return;
    removeKey(storageKeys.pending(b.deviceId, b.id));
    removeFromIndex(storageKeys.pendingIndex(b.deviceId), b.id);
    const memoryOnly = new Set(this.state.memoryOnly);
    memoryOnly.delete(id);
    this.patch({
      drafts: this.state.drafts.filter((x) => x.id !== id),
      memoryOnly,
    });
    this.notify("ok", `未确认记录 ${b.deviceId}#${b.seq} 已作废（序号不复用）`);
  }

  // ───────────────────────── 网络恢复：同步 + 合并 ─────────────────────────

  /** 当前设备已知的版本向量：服务器并集 + 本机已确认 */
  private knownVV(): VersionVector {
    let vv: VersionVector = {};
    for (const b of this.state.serverBatches) vv = vvMerge(vv, { [b.deviceId]: b.seq });
    for (const b of this.state.localConfirmed) vv = vvMerge(vv, { [b.deviceId]: b.seq });
    return vv;
  }

  /**
   * 同步：把本机已确认记录包按 id 幂等写入工单服务器。
   * 重复提交（同 id）直接跳过，不重复增加维护次数。
   */
  sync(): { pushed: number; duplicated: number } {
    if (!this.state.online) {
      this.notify("warn", "仍处于离线状态，无法同步");
      return { pushed: 0, duplicated: 0 };
    }
    const serverIds = new Set(this.state.serverBatches.map((b) => b.id));
    let pushed = 0;
    let duplicated = 0;
    for (const b of this.state.localConfirmed) {
      if (serverIds.has(b.id)) {
        duplicated += 1;
        continue;
      }
      const committed: Batch = { ...b, committed: true };
      try {
        putEnvelope(storageKeys.serverBatch(b.id), b.id, committed);
        addToIndex(storageKeys.serverIndex(), b.id);
        serverIds.add(b.id);
        pushed += 1;
      } catch (e) {
        if (e instanceof DiskWriteError) {
          this.notify("err", `记录 ${b.deviceId}#${b.seq} 并入工单时写盘失败，已确认原件仍可读，稍后重试`);
          break;
        }
        throw e;
      }
    }
    this.reloadServer();
    // 已成功并入的记录从本机待同步分区移除（原件在工单服务器仍可读）
    if (pushed > 0) {
      const remaining: Batch[] = [];
      for (const b of this.state.localConfirmed) {
        if (serverIds.has(b.id)) {
          removeKey(storageKeys.confirmed(b.deviceId, b.id));
          removeFromIndex(storageKeys.confirmedIndex(b.deviceId), b.id);
        } else {
          remaining.push(b);
        }
      }
      this.patch({ localConfirmed: remaining });
    }
    if (pushed > 0) this.notify("ok", `网络恢复：${pushed} 笔记录已按「音管 + 字段」并入工单`);
    if (duplicated > 0) {
      this.notify("warn", `${duplicated} 笔重复提交被幂等忽略，维护次数未重复增加`);
      this.patch({ rejectedDuplicates: this.state.rejectedDuplicates + duplicated });
    }
    if (pushed === 0 && duplicated === 0) {
      this.notify("ok", "工单已是最新，无待同步记录");
    }
    this.patch({ lastSyncAt: Date.now() });
    this.checkReportsFreshness();
    return { pushed, duplicated };
  }

  /** U 盘 / 内网摆渡：导入另一台设备的离线包 */
  importOfflinePackage(text: string) {
    let parsed;
    try {
      parsed = importPackages(text);
    } catch (e) {
      if (e instanceof CorruptPackageError) {
        this.notify("err", `${e.message}——已拒绝整包，已确认记录不受影响、仍可读`);
        return;
      }
      throw e;
    }
    let added = 0;
    for (const b of parsed.batches) {
      if (b.maintenanceId !== MAINTENANCE_ID) continue;
      try {
        putEnvelope(storageKeys.serverBatch(b.id), b.id, { ...b, committed: true });
        addToIndex(storageKeys.serverIndex(), b.id);
        added += 1;
      } catch (e) {
        if (e instanceof DiskWriteError) {
          this.notify("err", "离线包写入工单时写盘失败，已写入部分保留，可重新导入（自动去重）");
          break;
        }
        throw e;
      }
    }
    this.reloadServer();
    if (parsed.duplicated > 0) {
      this.notify("warn", `${parsed.duplicated} 笔重复记录被忽略，维护次数未重复增加`);
      this.patch({ rejectedDuplicates: this.state.rejectedDuplicates + parsed.duplicated });
    }
    this.notify(
      "ok",
      added > 0
        ? `离线包导入成功：新增 ${added} 笔，已按音管和字段合并`
        : "离线包内没有新记录（全部重复或属于其他工单）"
    );
  }

  exportOfflinePackage(): string {
    return exportPackages(this.state.serverBatches);
  }

  // ───────────────────────── 合并视图 ─────────────────────────

  private resolutionsOf(batches: Batch[]): Resolution[] {
    return batches
      .filter((b) => b.resolution)
      .map((b) => ({
        ...(b.resolution as Batch["resolution"] as NonNullable<Batch["resolution"]>),
        deviceId: b.deviceId,
        seq: b.seq,
        at: b.at,
      }));
  }

  /** 工单服务器的合并视图（仅已确认并入的记录包） */
  merged(): MergeResult {
    const committed = this.state.serverBatches.filter((b) => b.confirmed);
    return mergeBatches(committed, this.resolutionsOf(committed));
  }

  /** 选定冲突版本；裁决本身带设备序号 + 连续记录号，走确认/同步流程，天然幂等 */
  resolveConflict(tech: string, pipeId: string, field: PipeField, chosenVersion: string) {
    const m = this.merged();
    const basis = m.vv;
    this.saveDraft(tech, [], { pipeId, field, chosenVersion, basis });
  }

  // ───────────────────────── 单次维护报告 ─────────────────────────

  /** 未确认记录不能进入报告；有未裁决冲突时不出报告 */
  reportGate(): { ok: boolean; reasons: string[] } {
    const reasons: string[] = [];
    if (this.state.drafts.length > 0) {
      reasons.push(`还有 ${this.state.drafts.length} 笔未确认记录，确认或作废后才能生成报告`);
    }
    if (this.state.localConfirmed.length > 0) {
      reasons.push(
        this.state.online
          ? `还有 ${this.state.localConfirmed.length} 笔已确认记录未并入工单，请先同步`
          : `离线中：${this.state.localConfirmed.length} 笔已确认记录尚未在网络恢复后并入工单`
      );
    }
    const m = this.merged();
    const unresolved = m.conflicts.filter((c) => !c.resolution);
    if (unresolved.length > 0) {
      reasons.push(`还有 ${unresolved.length} 处双版本冲突未裁决（同字段两边都改过）`);
    }
    const blocked = [...m.pipes.values()].filter((p) => p.releaseBlocked);
    if (blocked.length > 0) {
      reasons.push(`${blocked.length} 支异常音管因音栓复检未完成，解除被拦截`);
    }
    return { ok: reasons.length === 0, reasons };
  }

  generateReport(tech: string): ReportSnapshot | null {
    const gate = this.reportGate();
    if (!gate.ok) {
      for (const r of gate.reasons) this.notify("err", r);
      return null;
    }
    const m = this.merged();
    const confirmed = m.batches.filter((b) => b.confirmed);
    const overLimit = [...m.pipes.values()].filter((p) => {
      const c = p.fields.cent?.value;
      if (!c) return false;
      const n = parseFloat(c);
      return Number.isFinite(n) && Math.abs(n) > 5;
    }).length;
    const abnormalCount = [...m.pipes.values()].filter((p) => p.abnormal).length;
    const snapshot: ReportSnapshot = {
      maintenanceId: MAINTENANCE_ID,
      generatedAt: Date.now(),
      generatedBy: tech,
      deviceId: this.state.currentDeviceId,
      basedOnBatchIds: confirmed.map((b) => b.id),
      signature: reportSignature(confirmed, this.resolutionsOf(confirmed), m.climate),
      abnormalCount,
      overLimitCount: overLimit,
      pipeCount: m.pipes.size,
      stopCount: m.stops.size,
      temperature: m.climate?.temperature ?? null,
      humidity: m.climate?.humidity ?? null,
      note: m.climate?.note ?? "",
    };
    try {
      putEnvelope(storageKeys.report(MAINTENANCE_ID), MAINTENANCE_ID, snapshot);
    } catch (e) {
      if (e instanceof DiskWriteError) {
        this.notify("err", "报告写盘失败：记录数据未受影响，可稍后重新生成");
        return null;
      }
      throw e;
    }
    this.patch({ reports: [snapshot] });
    this.notify("ok", "单次维护报告已生成并封存为快照");
    return snapshot;
  }

  /** 旧报告是否需要重算：记录、裁决或温湿度变化都会改变签名 */
  reportStatus(): { report: ReportSnapshot | null; stale: boolean; reasons: string[] } {
    const report = this.state.reports[0] ?? null;
    if (!report) return { report: null, stale: false, reasons: [] };
    const m = this.merged();
    const confirmed = m.batches.filter((b) => b.confirmed);
    const currentSig = reportSignature(confirmed, this.resolutionsOf(confirmed), m.climate);
    const reasons: string[] = [];
    if (currentSig !== report.signature) {
      // 区分原因：是否温湿度变化导致音分偏差结论失效
      const stalePipes = [...m.pipes.values()].filter((p) =>
        climateStale(p.fields.cent?.climate, m.climate)
      );
      if (
        (report.temperature !== null &&
          report.humidity !== null &&
          m.climate &&
          (Math.abs(m.climate.temperature - report.temperature) > 2 ||
            Math.abs(m.climate.humidity - report.humidity) > 8)) ||
        stalePipes.length > 0
      ) {
        const reportClimate =
          report.temperature !== null && report.humidity !== null
            ? { temperature: report.temperature, humidity: report.humidity }
            : null;
        reasons.push(
          `温湿度已变化（报告 ${reportClimate ? formatTempHum(reportClimate) : "—"} → 当前 ${m.climate ? formatTempHum(m.climate) : "—"}），${stalePipes.length} 支音管的音分偏差结论失效，旧报告需重算`
        );
      } else {
        reasons.push("报告生成后有新确认记录并入或冲突裁决变化，旧报告需重算");
      }
    }
    return { report, stale: reasons.length > 0, reasons };
  }

  private checkReportsFreshness() {
    const { stale, reasons } = this.reportStatus();
    if (stale) for (const r of reasons) this.notify("warn", r);
  }

  // ───────────────────────── 维护次数统计（按批次 id 去重） ─────────────────────────

  maintenanceCount(): number {
    return new Set(this.state.serverBatches.map((b) => b.id)).size;
  }

  pipeMaintenanceCount(pipeId: string): number {
    return new Set(
      this.state.serverBatches
        .filter((b) => b.entries.some((e) => "pipeId" in e && e.pipeId === pipeId))
        .map((b) => b.id)
    ).size;
  }

  /** 演练：破坏一条工单分区记录（其余记录应仍可读，损坏条目被隔离） */
  corruptOneServerBatch() {
    const target = this.state.serverBatches.find((b) => !b.id.startsWith("seed"))
      ?? this.state.serverBatches[this.state.serverBatches.length - 1];
    if (!target) return;
    localStorage.setItem(storageKeys.serverBatch(target.id), "{损坏的离线包数据-¤@#");
    this.reloadServer();
    this.notify("warn", "已破坏一条本地分区记录用于演练：其余已确认记录仍可读");
  }

  /** 重建索引：清掉已损坏/已丢失的 id 引用 */
  rebuildIndexes() {
    const keep = this.state.serverBatches.map((b) => b.id);
    putPlain(storageKeys.serverIndex(), keep);
    this.patch({ corruptKeys: [] });
    this.notify("ok", "索引已重建，损坏条目已隔离，可读记录全部保留");
  }
}

function formatTempHum(c: { temperature: number; humidity: number }): string {
  return `${c.temperature}°C/${c.humidity}%`;
}

export const store = new MaintenanceStore();
export { MAINTENANCE_ID };
