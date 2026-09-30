import { useState } from "react";
import type { State } from "../engine/types";
import { deviceName, fieldValue } from "../engine/store";
import { Badge, Btn, Banner } from "./bits";

function describeOp(state: State, op: { kind: string; pipeId?: string; field?: string; value?: string; venue?: string; env?: { temp: number; humidity: number }; stopKey?: string; result?: string; title?: string }): string {
  switch (op.kind) {
    case "pipe":
      return `新建音管 ${op.pipeId?.split("||")[2] ?? ""}`;
    case "field":
      return `${op.pipeId?.split("||")[2] ?? ""} · ${fieldLabel(op.field ?? "")} = ${op.value ?? ""}`;
    case "env":
      return `温湿度 ${op.env?.temp}°C / ${op.env?.humidity}%（${op.venue}）`;
    case "reinspect":
      return `音栓复检 ${op.stopKey?.split("||")[1] ?? ""} · ${op.result ?? ""}`;
    case "report":
      return `维护报告《${op.title}》`;
    default:
      return op.kind;
  }
}

function fieldLabel(f: string): string {
  return ({ pitch: "音高", cent: "音分偏差", reed: "簧片状态", note: "维修备注", abnormal: "异常标记" } as Record<string, string>)[f] ?? f;
}

export default function SyncCenter({
  state,
  pkgStatus,
  lastPersistFailed,
  writeFailArmed,
  onMerge,
  onAddDevice,
  onSetActive,
  onSetOnline,
  onResolve,
  onConfirm,
  onConfirmAll,
  onArmWriteFail,
  onCorrupt,
}: {
  state: State;
  pkgStatus: string;
  lastPersistFailed: boolean;
  writeFailArmed: boolean;
  onMerge: () => void;
  onAddDevice: () => void;
  onSetActive: (id: string) => void;
  onSetOnline: (online: boolean) => void;
  onResolve: (pipeId: string, field: string, opId: string) => void;
  onConfirm: (pipeId: string) => void;
  onConfirmAll: () => void;
  onArmWriteFail: () => void;
  onCorrupt: () => void;
}) {
  const [, setTick] = useState(0);
  const rerender = () => setTick((t) => t + 1);

  // 冲突字段
  const conflicts: Array<{ pipeId: string; field: string; versions: { opId: string; deviceId: string; seq: number; value: string; ts: number }[] }> = [];
  for (const pipe of Object.values(state.pipes)) {
    for (const [field, fs] of Object.entries(pipe.fields)) {
      if (fs && fs.status === "conflict") conflicts.push({ pipeId: pipe.id, field, versions: fs.versions });
    }
  }
  const pendingPipes = Object.values(state.pipes).filter((p) => p.status === "pending");
  const confirmedCount = Object.values(state.pipes).filter((p) => p.status === "confirmed").length;

  return (
    <div className="sync-stack">
      {/* 设备与网络 */}
      <div className="panel">
        <div className="heading">
          <div>
            <p>设备与网络</p>
            <h2>现场设备身份</h2>
          </div>
          <Badge tone={state.online ? "green" : "gray"}>{state.online ? "在线" : "离线"}</Badge>
        </div>
        <div className="device-row">
          {state.devices.map((d) => (
            <button
              key={d.id}
              className={`device-chip ${d.id === state.activeDeviceId ? "device-chip-active" : ""}`}
              onClick={() => onSetActive(d.id)}
            >
              <strong>{d.name}</strong>
              <span className="mono">{d.id}</span>
              <em>已连续记录 #{state.seqByDevice[d.id] ?? 0}</em>
            </button>
          ))}
          <Btn small onClick={onAddDevice}>
            + 模拟另一名技师
          </Btn>
        </div>
        <p className="hint">每笔修改都带设备序号与该设备上连续递增的记录号（opId = 设备序号:记录号）。</p>
        <div className="online-row">
          <Btn small onClick={() => onSetOnline(!state.online)}>
            {state.online ? "切换为离线" : "切换为在线"}
          </Btn>
          {state.online && state.outbox.length > 0 && (
            <Btn small primary onClick={onMerge}>
              网络恢复，合并 {state.outbox.length} 条离线记录
            </Btn>
          )}
        </div>
      </div>

      {/* 写盘失败横幅 */}
      {lastPersistFailed && (
        <Banner tone="red">
          <strong>写盘失败：</strong>
          已确认记录仍可读取，{state.outbox.length} 条未写入内容保留在离线工单中，可重新提交，不会重复增加维护次数。
          <span className="banner-action">
            <Btn small primary onClick={onMerge}>
              重新提交离线工单
            </Btn>
          </span>
        </Banner>
      )}

      {/* 离线工单 */}
      <div className="panel">
        <div className="heading">
          <div>
            <p>离线工单</p>
            <h2>待合并修改（{state.outbox.length}）</h2>
          </div>
          <Btn primary onClick={onMerge} disabled={state.outbox.length === 0}>
            网络恢复 · 按音管+字段合并
          </Btn>
        </div>
        {state.outbox.length === 0 ? (
          <p className="empty">离线工单已全部合并提交。</p>
        ) : (
          <div className="outbox">
            {state.outbox.map((op) => (
              <article key={op.opId} className="outbox-item">
                <Badge tone="amber">待提交</Badge>
                <div>
                  <strong>{describeOp(state, op)}</strong>
                  <p>
                    {deviceName(state, op.deviceId)} · 记录 #{op.seq} ·{" "}
                    {new Date(op.ts).toLocaleTimeString("zh-CN")}
                  </p>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {/* 冲突：同一字段两边都改过，保留两版 */}
      {conflicts.length > 0 && (
        <div className="panel">
          <div className="heading">
            <div>
              <p>合并冲突</p>
              <h2>同一字段两边都改过 · 两版均保留</h2>
            </div>
            <Badge tone="red">{conflicts.length} 个字段冲突</Badge>
          </div>
          <div className="conflict-list">
            {conflicts.map((c) => (
              <article key={`${c.pipeId}:${c.field}`} className="conflict-card">
                <h3>
                  {c.pipeId.split("||")[2]} · {fieldLabel(c.field)}
                </h3>
                <div className="conflict-versions">
                  {c.versions.map((v) => (
                    <div key={v.opId} className="conflict-version">
                      <div className="conflict-version-head">
                        <Badge tone="blue">{deviceName(state, v.deviceId)}</Badge>
                        <span className="mono">
                          #{v.seq} · {new Date(v.ts).toLocaleTimeString("zh-CN")}
                        </span>
                      </div>
                      <p className="conflict-value">{v.value || "（空）"}</p>
                      <Btn
                        small
                        onClick={() => {
                          onResolve(c.pipeId, c.field, v.opId);
                          rerender();
                        }}
                      >
                        采用此版
                      </Btn>
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </div>
      )}

      {/* 待确认 */}
      <div className="panel">
        <div className="heading">
          <div>
            <p>确认</p>
            <h2>合并结果确认</h2>
          </div>
          <Btn small onClick={onConfirmAll} disabled={pendingPipes.length === 0}>
            全部确认
          </Btn>
        </div>
        <p className="hint">
          已确认音管 {confirmedCount} 根，待确认 {pendingPipes.length} 根。冲突字段需先裁决采用版本，确认后才能进入单次维护报告。
        </p>
        <div className="confirm-list">
          {pendingPipes.map((pipe) => {
            const unresolved = Object.entries(pipe.fields).filter(([, fs]) => fs?.status === "conflict");
            return (
              <article key={pipe.id} className="confirm-item">
                <div>
                  <strong>{pipe.id.split("||")[2]}</strong>
                  <p>
                    {pipe.stopName} ·{" "}
                    {Object.entries(pipe.fields)
                      .filter(([, fs]) => fs && fs.status !== "confirmed")
                      .map(([f, fs]) => `${fieldLabel(f)}${fs!.status === "conflict" ? "（冲突）" : fs!.status === "resolved" ? "（已裁决）" : "（待确认）"}`)
                      .join("、")}
                  </p>
                </div>
                <Btn small primary onClick={() => onConfirm(pipe.id)} disabled={unresolved.length > 0}>
                  确认
                </Btn>
              </article>
            );
          })}
          {pendingPipes.length === 0 && <p className="empty">所有音管均已确认。</p>}
        </div>
      </div>

      {/* 离线包耐久性 */}
      <div className="panel">
        <div className="heading">
          <div>
            <p>离线包耐久性</p>
            <h2>写盘失败与损坏兜底</h2>
          </div>
          <Badge tone={pkgStatus === "完整" ? "green" : "amber"}>离线包：{pkgStatus}</Badge>
        </div>
        <div className="durability-row">
          <Btn small onClick={onArmWriteFail} disabled={writeFailArmed}>
            {writeFailArmed ? "已武装：下次写盘将失败" : "模拟下次写盘失败"}
          </Btn>
          <Btn small danger onClick={onCorrupt}>
            损坏离线包并重新加载
          </Btn>
        </div>
        <p className="hint">
          每次落盘都写校验和并保留上一个完整包。写盘失败时已确认记录仍可读、未写入内容留在离线工单可重新提交；包损坏时自动回退到上一个完整包；重复提交按 opId 去重，维护次数不会重复增加。
        </p>
      </div>
    </div>
  );
}
