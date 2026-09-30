import { useMemo, useState } from "react";
import "./styles.css";
import { useStore } from "./useStore";
import { BatchComposer } from "./Composer";
import { Outbox } from "./Outbox";
import { MergedView } from "./MergedView";
import { ReportView } from "./ReportView";
import { SyncPanel } from "./SyncPanel";
import { Badge } from "./ui";

type Tab = "record" | "ledger" | "report" | "sync";

const TABS: [Tab, string][] = [
  ["record", "现场补记"],
  ["ledger", "工单合并台"],
  ["report", "单次维护报告"],
  ["sync", "同步与故障恢复"],
];

function App() {
  const store = useStore();
  const [tab, setTab] = useState<Tab>("record");
  const m = useMemo(() => store.merged(), [store.state.serverBatches]);
  const { report, stale } = store.reportStatus();
  const overLimit = [...m.pipes.values()].filter((p) => {
    const n = parseFloat(p.fields.cent?.value ?? "");
    return Number.isFinite(n) && Math.abs(n) > 5;
  }).length;
  const abnormal = [...m.pipes.values()].filter((p) => p.abnormal).length;

  if (!store.state.ready) return null;

  return (
    <main className="app">
      <section className="hero">
        <p>hxyfront-62005 · 可续作现场维护 · {store.state.currentDeviceId}</p>
        <h1>管风琴音管调音记录台</h1>
        <span>
          离线可记录、每笔修改带设备序号与连续记录号；网络恢复后按音管和字段合并，
          同字段两边都改过则两版并存待裁决；未确认记录不进入单次维护报告；
          音栓复检完成前异常音管不能解除；温湿度变化使旧偏差结论与旧报告失效重算。
        </span>
      </section>

      <section className="metrics">
        <article>
          <small>音栓数量</small>
          <strong>{m.stops.size}</strong>
        </article>
        <article>
          <small>偏差超限(±5音分)</small>
          <strong>{overLimit}</strong>
        </article>
        <article>
          <small>异常音管</small>
          <strong>{abnormal}</strong>
        </article>
        <article>
          <small>当前温度 / 湿度</small>
          <strong>
            {m.climate ? `${m.climate.temperature}°/${m.climate.humidity}%` : "—"}
          </strong>
        </article>
      </section>

      <nav className="tabs">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            data-testid={`tab-${key}`}
            className={tab === key ? "tab active" : "tab"}
            onClick={() => setTab(key)}
          >
            {label}
            {key === "record" && store.state.drafts.length > 0 && (
              <Badge tone="amber">{store.state.drafts.length}</Badge>
            )}
            {key === "report" && stale && <Badge tone="red">重算</Badge>}
            {key === "sync" && store.state.localConfirmed.length > 0 && !store.state.online && (
              <Badge tone="blue">{store.state.localConfirmed.length}</Badge>
            )}
          </button>
        ))}
      </nav>

      {store.state.notices.length > 0 && (
        <section className="notices">
          {store.state.notices.map((n) => (
            <div key={n.id} className={`notice notice-${n.kind}`}>
              {n.text}
            </div>
          ))}
          <button className="notice-clear" onClick={() => store.clearNotices()}>
            清空提示
          </button>
        </section>
      )}

      <div className="tab-body">
        {tab === "record" && (
          <div className="stack">
            <BatchComposer />
            <Outbox />
          </div>
        )}
        {tab === "ledger" && <MergedView />}
        {tab === "report" && <ReportView />}
        {tab === "sync" && <SyncPanel />}
      </div>

      <footer className="app-footer">
        <span>
          工单 WO-2026-StMary · 去重后记录 {store.maintenanceCount()} 笔 ·
          待裁决冲突 {m.conflicts.filter((c) => !c.resolution).length} ·
          报告 {report ? (stale ? "待重算" : "有效") : "未生成"}
        </span>
      </footer>
    </main>
  );
}

export default App;
