// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import App from "./App";
import { store } from "./store";
import { addToIndex, putEnvelope, putPlain, setWriteFailures, storageKeys } from "./storage";
import { Batch, EntryData, VersionVector } from "./types";

function resetStore() {
  localStorage.clear();
  setWriteFailures(0);
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
}

function pushBatch(b: Batch) {
  putEnvelope(storageKeys.serverBatch(b.id), b.id, b);
  addToIndex(storageKeys.serverIndex(), b.id);
}

function batch(
  deviceId: string,
  tech: string,
  seq: number,
  vv: VersionVector,
  entries: EntryData[]
): Batch {
  return {
    id: `t-${deviceId}-${seq}`,
    maintenanceId: "WO-2026-StMary",
    deviceId,
    tech,
    seq,
    at: Date.now() + seq,
    vv,
    entries,
    confirmed: true,
    committed: true,
  };
}

beforeEach(resetStore);
afterEach(cleanup);

describe("记录台界面冒烟与主流程", () => {
  it("四个页签均可渲染，种子数据显示音栓/音管/指标", () => {
    render(<App />);
    expect(screen.getByText("管风琴音管调音记录台")).toBeTruthy();

    fireEvent.click(screen.getByTestId("tab-ledger"));
    expect(screen.getByRole("heading", { name: /工单 WO-2026-StMary/ })).toBeTruthy();
    expect(screen.getByText("Trumpet 8'")).toBeTruthy();
    expect(screen.getByText("TP-Cs4")).toBeTruthy();
    expect(screen.getByText("当前温湿度")).toBeTruthy();

    // 种子数据：无未确认、无冲突、无非法解除 => 门控全绿，可以生成报告
    fireEvent.click(screen.getByTestId("tab-report"));
    expect(screen.getAllByText(/✓/).length).toBe(3);
    expect(screen.getByText("生成单次维护报告")).toBeTruthy();

    fireEvent.click(screen.getByTestId("tab-sync"));
    expect(screen.getByText("同步、摆渡与故障恢复")).toBeTruthy();
  });

  it("现场补记→未确认不入报告→确认离线挂起→恢复网络并入→生成报告", () => {
    render(<App />);
    fireEvent.click(document.querySelector('button[data-kind="climate"]')!);
    const tempInput = screen.getByDisplayValue("19.5");
    fireEvent.change(tempInput, { target: { value: "20.1" } });
    fireEvent.click(screen.getByText("加入本笔"));
    fireEvent.click(screen.getByText("暂存本笔（1 条）"));

    expect(screen.getAllByText(/ST-A#3/).length).toBeGreaterThan(0); // 种子占用 #1 #2

    fireEvent.click(screen.getByTestId("tab-report"));
    expect(screen.getByText("暂时不能进入单次维护报告：")).toBeTruthy();

    fireEvent.click(screen.getByTestId("tab-record"));
    fireEvent.click(screen.getByText("确认"));
    expect(screen.getByText("已确认 · 只读")).toBeTruthy();

    fireEvent.click(screen.getByTestId("tab-sync"));
    fireEvent.click(screen.getByText("恢复网络"));
    expect(screen.getAllByText(/按「音管 \+ 字段」并入工单/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId("tab-report"));
    expect(screen.getAllByText(/✓/).length).toBe(3);
    fireEvent.click(screen.getByText("生成单次维护报告"));
    expect(screen.getByText("现行有效")).toBeTruthy();
    expect(screen.getByText("已封存快照")).toBeTruthy();
  });

  it("写盘故障：记录显示仅内存，重新写入后恢复正常", () => {
    render(<App />);
    store.setFailureInjection(1);
    fireEvent.click(document.querySelector('button[data-kind="climate"]')!);
    fireEvent.click(screen.getByText("加入本笔"));
    fireEvent.click(screen.getByText("暂存本笔（1 条）"));
    expect(screen.getByText("仅内存 · 未写入")).toBeTruthy();
    fireEvent.click(screen.getByText("重新写入"));
    expect(screen.getByText("确认")).toBeTruthy();
  });

  it("双技师同时改同一字段：两版并存阻止报告，裁决后放行", () => {
    // 预置真分叉：两台设备在同一空基线上各写 P1.cent
    resetStore();
    const devices = [
      { id: "ST-A", tech: "陈技师" },
      { id: "ST-B", tech: "林技师" },
    ];
    putPlain(storageKeys.devices(), devices);
    putPlain(storageKeys.currentDevice(), "ST-A");
    putPlain(storageKeys.seq("ST-A"), 1);
    putPlain(storageKeys.seq("ST-B"), 1);
    pushBatch(
      batch("ST-A", "陈技师", 1, {}, [
        { kind: "pipe", pipeId: "P1", stopId: "S1", field: "cent", value: "+4" },
      ])
    );
    pushBatch(
      batch("ST-B", "林技师", 1, {}, [
        { kind: "pipe", pipeId: "P1", stopId: "S1", field: "cent", value: "-6" },
      ])
    );
    store.reloadFromDisk();
    render(<App />);

    fireEvent.click(screen.getByTestId("tab-ledger"));
    const conflictBox = screen.getByText("双版本冲突（两名技师同时保存）").closest("div")!;
    expect(screen.getByText("未裁决 · 两版并存")).toBeTruthy();
    expect(conflictBox.textContent).toContain("+4");
    expect(conflictBox.textContent).toContain("-6");

    fireEvent.click(screen.getByTestId("tab-report"));
    expect(screen.getByText("暂时不能进入单次维护报告：")).toBeTruthy();
    expect(screen.getAllByText(/双版本冲突/).length).toBeGreaterThan(0);

    // 裁决采用 -6（ST-B#1）
    fireEvent.click(screen.getByTestId("tab-ledger"));
    const choiceButtons = screen.getAllByText("采用此版（生成带记录号的裁决）");
    // -6 是第二个版本
    fireEvent.click(choiceButtons[1]);

    fireEvent.click(screen.getByTestId("tab-sync"));
    fireEvent.click(screen.getByText("恢复网络"));
    fireEvent.click(screen.getByTestId("tab-record"));
    fireEvent.click(screen.getByText("确认")); // 裁决包带设备序号 ST-A#2

    fireEvent.click(screen.getByTestId("tab-report"));
    expect(screen.getAllByText(/✓/).length).toBe(3);
    fireEvent.click(screen.getByText("生成单次维护报告"));
    expect(screen.getByText("现行有效")).toBeTruthy();
  });

  it("复检未完成解除异常被拦截，复检记录并入后解除生效", () => {
    render(<App />);
    fireEvent.click(document.querySelector('button[data-kind="abnormal"]')!);
    const stopInput = document.querySelector('input[list="stop-list"]') as HTMLInputElement;
    const pipeInput = document.querySelector('input[list="pipe-list"]') as HTMLInputElement;
    fireEvent.change(stopInput, { target: { value: "bourdon-16" } });
    fireEvent.change(pipeInput, { target: { value: "BD-F2" } });
    const select = document.querySelector(".form-body select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "0" } });
    fireEvent.click(screen.getByText("加入本笔"));
    fireEvent.click(screen.getByText("暂存本笔（1 条）"));
    fireEvent.click(screen.getByText("确认"));

    fireEvent.click(screen.getByTestId("tab-sync"));
    fireEvent.click(screen.getByText("恢复网络"));
    fireEvent.click(screen.getByTestId("tab-ledger"));
    expect(screen.getByText("解除被拦截")).toBeTruthy();

    // 补音栓复检
    fireEvent.click(screen.getByTestId("tab-record"));
    fireEvent.click(document.querySelector('button[data-kind="stop"]')!);
    const stopInput2 = document.querySelector(".form-body input") as HTMLInputElement;
    fireEvent.change(stopInput2, { target: { value: "bourdon-16" } });
    const checkbox = document.querySelector('.form-body input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByText("加入本笔"));
    fireEvent.click(screen.getByText("暂存本笔（1 条）"));
    fireEvent.click(screen.getByText("确认"));

    fireEvent.click(screen.getByTestId("tab-ledger"));
    expect(screen.getByText("复检后已解除")).toBeTruthy();
  });

  it("温湿度变化后旧报告标记需重算，重算后恢复有效", () => {
    render(<App />);
    // 种子基线下先生成报告
    fireEvent.click(screen.getByTestId("tab-report"));
    fireEvent.click(screen.getByText("生成单次维护报告"));
    expect(screen.getByText("现行有效")).toBeTruthy();

    // 温度大幅变化
    fireEvent.click(screen.getByTestId("tab-record"));
    fireEvent.click(document.querySelector('button[data-kind="climate"]')!);
    fireEvent.change(screen.getByDisplayValue("19.5"), { target: { value: "27" } });
    fireEvent.click(screen.getByText("加入本笔"));
    fireEvent.click(screen.getByText("暂存本笔（1 条）"));
    fireEvent.click(screen.getByText("确认"));
    fireEvent.click(screen.getByTestId("tab-sync"));
    fireEvent.click(screen.getByText("恢复网络"));

    fireEvent.click(screen.getByTestId("tab-report"));
    expect(screen.getByText("需重算")).toBeTruthy();
    expect(screen.getAllByText(/温湿度已变化/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText("按当前记录重新生成报告"));
    expect(screen.getByText("现行有效")).toBeTruthy();
  });
});
