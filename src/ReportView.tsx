import { useMemo } from "react";
import { useStore } from "./useStore";
import { Badge, fmtTime } from "./ui";

/** 单次维护报告：门控 + 快照封存 + 温湿度/记录变化后要求重算 */
export function ReportView() {
  const store = useStore();
  const gate = useMemo(() => store.reportGate(), [
    store.state.drafts,
    store.state.localConfirmed,
    store.state.serverBatches,
  ]);
  const { report, stale, reasons } = store.reportStatus();
  const m = useMemo(() => store.merged(), [store.state.serverBatches]);
  const tech = store.state.devices.find((d) => d.id === store.state.currentDeviceId)?.tech ?? "";

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>单次维护报告</p>
          <h2>{report ? "已封存快照" : "尚未生成"}</h2>
        </div>
        {report &&
          (stale ? <Badge tone="red">需重算</Badge> : <Badge tone="green">现行有效</Badge>)}
      </div>

      <ul className="gate-list">
        <GateRow ok={store.state.drafts.length === 0} text={`未确认记录为零（当前 ${store.state.drafts.length} 笔，未确认不能进入报告）`} />
        <GateRow ok={m.conflicts.every((c) => c.resolution)} text={`双版本冲突全部裁决（待裁决 ${m.conflicts.filter((c) => !c.resolution).length} 处）`} />
        <GateRow
          ok={[...m.pipes.values()].every((p) => !p.releaseBlocked)}
          text="异常音管解除均已通过音栓复检守卫"
        />
      </ul>

      {!gate.ok && (
        <div className="report-block">
          <h3>暂时不能进入单次维护报告：</h3>
          <ul>
            {gate.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="form-actions">
        <button
          className="primary"
          disabled={!gate.ok}
          onClick={() => store.generateReport(tech)}
        >
          {report ? "按当前记录重新生成报告" : "生成单次维护报告"}
        </button>
        {!gate.ok && <span className="muted">满足左侧全部条件后可生成</span>}
      </div>

      {report && (
        <article className={stale ? "report-snapshot stale" : "report-snapshot"}>
          <header>
            <strong>{report.maintenanceId}</strong>
            <span className="muted">
              {fmtTime(report.generatedAt)} · {report.generatedBy} · {report.deviceId}
            </span>
            {stale ? (
              <Badge tone="red">旧报告 · 待重算</Badge>
            ) : (
              <Badge tone="green">与当前记录一致</Badge>
            )}
          </header>
          <div className="report-grid">
            <Metric label="音栓" value={report.stopCount} />
            <Metric label="音管" value={report.pipeCount} />
            <Metric label="偏差超限(±5音分)" value={report.overLimitCount} />
            <Metric label="异常音管" value={report.abnormalCount} />
            <Metric
              label="封存时温湿度"
              value={report.temperature !== null ? `${report.temperature}°C / ${report.humidity}%` : "—"}
            />
            <Metric label="纳入记录包" value={`${report.basedOnBatchIds.length} 笔`} />
          </div>
          {report.note && <p className="muted">气候备注：{report.note}</p>}
          <p className="muted small">
            内容签名 {report.signature}
            {stale && " · 签名已与当前工单不一致"}
          </p>
          {stale && (
            <div className="stale-reasons">
              {reasons.map((r, i) => (
                <p key={i}>⚠️ {r}</p>
              ))}
            </div>
          )}
        </article>
      )}
    </section>
  );
}

function GateRow({ ok, text }: { ok: boolean; text: string }) {
  return (
    <li className={ok ? "gate ok" : "gate no"}>
      <span className="gate-mark">{ok ? "✓" : "○"}</span>
      <span>{text}</span>
    </li>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="report-metric">
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}
