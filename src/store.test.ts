// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { Batch, EntryData, PipeField, Resolution, VersionVector } from "./types";
import { mergeBatches, climateStale } from "./merge";
import { store } from "./store";
import { putEnvelope, addToIndex, getEnvelope, setWriteFailures, storageKeys } from "./storage";

// 构造两台设备在同一基线上并发修改的记录包
function makeBatch(
  deviceId: string,
  tech: string,
  seq: number,
  vv: VersionVector,
  entries: EntryData[],
  opts: Partial<Batch> = {}
): Batch {
  return {
    id: opts.id ?? `${deviceId}-${seq}-${Math.random().toString(36).slice(2, 7)}`,
    maintenanceId: "WO-2026-StMary",
    deviceId,
    tech,
    seq,
    at: opts.at ?? Date.now(),
    vv,
    entries,
    confirmed: true,
    committed: true,
    climate: opts.climate,
    resolution: opts.resolution,
  };
}

function serverPush(b: Batch) {
  putEnvelope(storageKeys.serverBatch(b.id), b.id, b);
  addToIndex(storageKeys.serverIndex(), b.id);
}

describe("网络恢复后按音管 + 字段合并", () => {
  it("不同字段的并发修改各自保留，不产生冲突", () => {
    const base: VersionVector = { "ST-A": 2, "ST-B": 1 };
    const a = makeBatch("ST-A", "陈技师", 3, base, [
      { kind: "pipe", pipeId: "P1", stopId: "S1", field: "cent", value: "+4" },
    ]);
    const b = makeBatch("ST-B", "林技师", 2, base, [
      { kind: "pipe", pipeId: "P1", stopId: "S1", field: "note", value: "已清理" },
    ]);
    const m = mergeBatches([a, b]);
    expect(m.conflicts).toHaveLength(0);
    expect(m.pipes.get("P1")!.fields.cent!.value).toBe("+4");
    expect(m.pipes.get("P1")!.fields.note!.value).toBe("已清理");
  });

  it("同一字段两边都改过（版本向量分叉）时保留两版", () => {
    const base: VersionVector = { "ST-A": 2, "ST-B": 1 };
    const a = makeBatch("ST-A", "陈技师", 3, base, [
      { kind: "pipe", pipeId: "P1", stopId: "S1", field: "cent", value: "+4" },
    ], { at: 1000 });
    const b = makeBatch("ST-B", "林技师", 2, base, [
      { kind: "pipe", pipeId: "P1", stopId: "S1", field: "cent", value: "-6" },
    ], { at: 2000 });
    const m = mergeBatches([a, b]);
    expect(m.conflicts).toHaveLength(1);
    const c = m.conflicts[0];
    expect(c.field).toBe("cent");
    expect(c.versions.map((v) => v.value).sort()).toEqual(["+4", "-6"]);
    expect(m.pipes.get("P1")!.conflicts).toContain("cent");
  });

  it("后写者已见过先写版本时因果覆盖，只留新版", () => {
    const first = makeBatch("ST-A", "陈技师", 3, { "ST-A": 2 }, [
      { kind: "pipe", pipeId: "P1", stopId: "S1", field: "cent", value: "+4" },
    ], { at: 1000 });
    const second = makeBatch("ST-B", "林技师", 2, { "ST-A": 3, "ST-B": 1 }, [
      { kind: "pipe", pipeId: "P1", stopId: "S1", field: "cent", value: "-6" },
    ], { at: 2000 });
    const m = mergeBatches([first, second]);
    expect(m.conflicts).toHaveLength(0);
    expect(m.pipes.get("P1")!.fields.cent!.value).toBe("-6");
  });

  it("冲突裁决只让所选版本生效；裁决自身可随设备序号合并", () => {
    const base: VersionVector = { "ST-A": 2, "ST-B": 1 };
    const a = makeBatch("ST-A", "陈技师", 3, base, [
      { kind: "pipe", pipeId: "P1", stopId: "S1", field: "cent", value: "+4" },
    ], { at: 1000 });
    const b = makeBatch("ST-B", "林技师", 2, base, [
      { kind: "pipe", pipeId: "P1", stopId: "S1", field: "cent", value: "-6" },
    ], { at: 2000 });
    const resolution: Resolution = {
      deviceId: "ST-B",
      seq: 3,
      at: 3000,
      pipeId: "P1",
      field: "cent" as PipeField,
      chosenVersion: "ST-A#3",
      basis: { "ST-A": 3, "ST-B": 2 },
    };
    const m = mergeBatches([a, b], [resolution]);
    expect(m.conflicts[0].resolution!.chosenVersion).toBe("ST-A#3");
    expect(m.pipes.get("P1")!.fields.cent!.value).toBe("+4");
  });
});

describe("音栓复检守卫", () => {
  it("复检完成前申请解除异常：解除被拦截，音管保持异常", () => {
    const mark = makeBatch("ST-A", "陈", 1, {}, [
      { kind: "abnormal", pipeId: "P1", stopId: "S1", abnormal: true, reason: "偏差大" },
    ], { at: 1000 });
    const release = makeBatch("ST-B", "林", 1, {}, [
      { kind: "abnormal", pipeId: "P1", stopId: "S1", abnormal: false, reason: "调好了" },
    ], { at: 2000 });
    const m = mergeBatches([mark, release]);
    const p = m.pipes.get("P1")!;
    expect(p.abnormal).toBe(true);
    expect(p.releaseBlocked).toBeTruthy();
    expect(p.released).toBeFalsy();
  });

  it("音栓复检完成后的解除才生效", () => {
    const stop = makeBatch("ST-A", "陈", 1, {}, [
      { kind: "stop", stopId: "S1", recheckDone: true },
    ], { at: 500 });
    const mark = makeBatch("ST-A", "陈", 2, {}, [
      { kind: "abnormal", pipeId: "P1", stopId: "S1", abnormal: true },
    ], { at: 1000 });
    const release = makeBatch("ST-B", "林", 1, {}, [
      { kind: "abnormal", pipeId: "P1", stopId: "S1", abnormal: false },
    ], { at: 2000 });
    const m = mergeBatches([stop, mark, release]);
    const p = m.pipes.get("P1")!;
    expect(p.abnormal).toBe(false);
    expect(p.released).toBeTruthy();
  });

  it("只标记不解除的异常不受复检影响", () => {
    const mark = makeBatch("ST-A", "陈", 1, {}, [
      { kind: "abnormal", pipeId: "P1", stopId: "S1", abnormal: true },
    ]);
    const m = mergeBatches([mark]);
    expect(m.pipes.get("P1")!.abnormal).toBe(true);
    expect(m.pipes.get("P1")!.releaseBlocked).toBeFalsy();
  });
});

describe("温湿度使偏差结论与旧报告失效", () => {
  it("变化超 ±2°C / ±8% 判定失效，边界内仍有效", () => {
    expect(climateStale({ temperature: 19.5, humidity: 42 }, { temperature: 22, humidity: 42 })).toBe(true);
    expect(climateStale({ temperature: 19.5, humidity: 42 }, { temperature: 21, humidity: 52 })).toBe(true);
    expect(climateStale({ temperature: 19.5, humidity: 42 }, { temperature: 21, humidity: 45 })).toBe(false);
  });

  it("合并视图中绑定旧气候的 cent 版本被标记失效", () => {
    const climate1 = makeBatch("ST-A", "陈", 1, {}, [
      { kind: "climate", at: 1000, temperature: 19.5, humidity: 42 },
      { kind: "pipe", pipeId: "P1", stopId: "S1", field: "cent", value: "+9" },
    ], { at: 1000, climate: { temperature: 19.5, humidity: 42, at: 1000 } });
    const climate2 = makeBatch("ST-A", "陈", 2, { "ST-A": 1 }, [
      { kind: "climate", at: 5000, temperature: 26, humidity: 42 },
    ], { at: 5000 });
    const m = mergeBatches([climate1, climate2]);
    const v = m.pipes.get("P1")!.fields.cent!;
    expect(climateStale(v.climate, m.climate)).toBe(true);
  });
});

describe("记录台端到端流程", () => {
  beforeEach(() => {
    localStorage.clear();
    setWriteFailures(0);
    // 重新初始化 store 单例状态
    (store as unknown as { state: unknown }).state = {
      ready: false,
      devices: [],
      currentDeviceId: "",
      online: false,
      drafts: [],
      memoryOnly: new Set<string>(),
      localConfirmed: [],
      serverBatches: [],
      reports: [],
      corruptKeys: [],
      notices: [],
      lastSyncAt: null,
      rejectedDuplicates: 0,
    };
    store.init();
  });

  it("每笔修改带设备序号和连续记录号，同设备序号单调递增", () => {
    const dev = store.state.currentDeviceId;
    const before = store.currentSeq();
    const r1 = store.saveDraft("陈技师", [
      { kind: "climate", at: Date.now(), temperature: 20, humidity: 40 },
    ]);
    const r2 = store.saveDraft("陈技师", [
      { kind: "pipe", pipeId: "P1", stopId: "S1", field: "note", value: "x" },
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const tags = store.state.drafts.map((b) => `${b.deviceId}#${b.seq}`).sort();
    expect(tags).toEqual([`${dev}#${before + 1}`, `${dev}#${before + 2}`]);
    expect(store.currentSeq()).toBe(before + 2);
  });

  it("未确认记录不进入报告；确认且在线同步后合并、维护次数去重", () => {
    store.setOnline(false);
    const r = store.saveDraft("陈技师", [
      { kind: "pipe", pipeId: "P9", stopId: "S1", field: "cent", value: "+1" },
    ]);
    // 未确认：报告门控不通过
    expect(store.reportGate().ok).toBe(false);
    expect(store.merged().pipes.has("P9")).toBe(false);

    store.confirmDraft(r.id!);
    expect(store.reportGate().ok).toBe(false); // 还离线：未并入工单
    expect(store.state.localConfirmed).toHaveLength(1);

    store.setOnline(true);
    const m = store.merged();
    expect(m.pipes.get("P9")!.fields.cent!.value).toBe("+1");

    // 重复提交（离线包/网络重传，同一批次 id）不能重复增加维护次数
    const countOnce = store.maintenanceCount();
    store.importOfflinePackage(store.exportOfflinePackage());
    expect(store.maintenanceCount()).toBe(countOnce);
    expect(store.state.rejectedDuplicates).toBeGreaterThan(0);
  });

  it("两名技师同时改同一字段：冲突未裁决前不能出报告，裁决后可以", () => {
    const base: VersionVector = {};
    serverPush(
      makeBatch("ST-A", "陈技师", 100, base, [
        { kind: "pipe", pipeId: "PX", stopId: "S1", field: "cent", value: "+4" },
      ], { at: 1000 })
    );
    serverPush(
      makeBatch("ST-B", "林技师", 100, base, [
        { kind: "pipe", pipeId: "PX", stopId: "S1", field: "cent", value: "-6" },
      ], { at: 2000 })
    );
    // 触发重新读取
    store.setOnline(true);
    expect(store.merged().conflicts).toHaveLength(1);
    const gate = store.reportGate();
    expect(gate.ok).toBe(false);
    expect(gate.reasons.join("")).toContain("冲突");

    store.resolveConflict("陈技师", "PX", "cent", "ST-B#100");
    expect(store.state.drafts).toHaveLength(1);
    store.confirmDraft(store.state.drafts[0].id);
    store.sync();
    expect(store.merged().conflicts[0].resolution!.chosenVersion).toBe("ST-B#100");
    expect(store.merged().pipes.get("PX")!.fields.cent!.value).toBe("-6");
    expect(store.reportGate().ok).toBe(true);
  });

  it("写盘失败后内容仅存内存、可重新写入，且重试不重复增加维护次数", () => {
    setWriteFailures(1);
    const r = store.saveDraft("陈技师", [
      { kind: "pipe", pipeId: "P7", stopId: "S1", field: "note", value: "未落盘" },
    ]);
    expect(r.ok).toBe(false);
    const b = store.state.drafts.find((x) => x.id === r.id)!;
    // 磁盘上没有
    expect(getEnvelope(storageKeys.pending(b.deviceId, b.id))).toBeNull();
    // 内存中仍可读
    expect(b.entries[0]).toMatchObject({ value: "未落盘" });

    setWriteFailures(0);
    store.rewriteDraft(b.id);
    expect(getEnvelope(storageKeys.pending(b.deviceId, b.id))).not.toBeNull();

    store.confirmDraft(b.id);
    store.setOnline(true);
    const count = store.maintenanceCount();
    // 同一批记录通过离线包再次提交（重传），按批次 id 去重
    store.importOfflinePackage(store.exportOfflinePackage());
    expect(store.maintenanceCount()).toBe(count);
  });

  it("已确认记录在坏包/坏分区下仍可读，损坏条目被隔离", () => {
    store.setOnline(false);
    const r = store.saveDraft("陈技师", [
      { kind: "pipe", pipeId: "P8", stopId: "S1", field: "note", value: "重要" },
    ]);
    store.confirmDraft(r.id!);
    const confirmedId = store.state.localConfirmed[0].id;
    expect(getEnvelope(storageKeys.confirmed(store.state.currentDeviceId, confirmedId))).not.toBeNull();

    // 损坏另一条服务器分区记录
    store.corruptOneServerBatch();
    expect(store.state.corruptKeys.length).toBeGreaterThan(0);
    // 本机已确认记录仍然完整可读
    const keep = getEnvelope(storageKeys.confirmed(store.state.currentDeviceId, confirmedId));
    expect(keep).not.toBeNull();
    expect((keep as Batch).entries[0]).toMatchObject({ pipeId: "P8" });

    store.rebuildIndexes();
    expect(store.state.corruptKeys).toHaveLength(0);
  });

  it("离线包损坏时整包拒绝，已有记录不受影响；重复包不重复计数", () => {
    store.setOnline(true);
    const before = store.state.serverBatches.length;
    store.importOfflinePackage("{不是合法的包");
    expect(store.state.serverBatches.length).toBe(before);

    const text = store.exportOfflinePackage();
    const count = store.maintenanceCount();
    store.importOfflinePackage(text); // 全部是重复 id
    expect(store.maintenanceCount()).toBe(count);
    expect(store.state.rejectedDuplicates).toBeGreaterThan(0);
  });

  it("报告生成后温湿度变化：旧报告标记需重算，重算后恢复有效", () => {
    store.setOnline(false);
    store.saveDraft("陈技师", [
      { kind: "stop", stopId: "SX", recheckDone: true },
      { kind: "climate", at: Date.now(), temperature: 19.5, humidity: 42 },
    ]);
    store.confirmDraft(store.state.drafts[0].id);
    store.setOnline(true);
    const r1 = store.generateReport("陈技师");
    expect(r1).not.toBeNull();
    expect(store.reportStatus().stale).toBe(false);

    // 温湿度显著变化
    store.setOnline(false);
    store.saveDraft("陈技师", [
      { kind: "climate", at: Date.now() + 1000, temperature: 27, humidity: 40 },
    ]);
    store.confirmDraft(store.state.drafts[0].id);
    store.setOnline(true);
    const status = store.reportStatus();
    expect(status.stale).toBe(true);
    expect(status.reasons.join("")).toMatch(/温湿度/);

    const r2 = store.generateReport("陈技师");
    expect(r2).not.toBeNull();
    expect(store.reportStatus().stale).toBe(false);
  });

  it("异常解除在音栓复检前被拦截，报告门控阻止；复检并入后解除生效", () => {
    store.setOnline(false);
    store.saveDraft("陈技师", [
      { kind: "abnormal", pipeId: "PZ", stopId: "SZ", abnormal: true, reason: "偏差" },
    ]);
    store.confirmDraft(store.state.drafts[0].id);
    store.saveDraft("林技师", [
      { kind: "abnormal", pipeId: "PZ", stopId: "SZ", abnormal: false, reason: "先解除" },
    ]);
    // 注意：第二笔仍在当前设备 ST-A 名下（设备序号机制按记录台，不按人名）
    store.confirmDraft(store.state.drafts[0].id);
    store.setOnline(true);
    const p = store.merged().pipes.get("PZ")!;
    expect(p.abnormal).toBe(true);
    expect(p.releaseBlocked).toBeTruthy();
    expect(store.reportGate().ok).toBe(false);

    store.setOnline(false);
    store.saveDraft("陈技师", [
      { kind: "stop", stopId: "SZ", recheckDone: true },
    ]);
    store.confirmDraft(store.state.drafts[0].id);
    store.setOnline(true);
    const p2 = store.merged().pipes.get("PZ")!;
    expect(p2.abnormal).toBe(false);
    expect(p2.released).toBeTruthy();
    expect(store.reportGate().ok).toBe(true);
  });
});
