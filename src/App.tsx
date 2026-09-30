import { useMemo, useState } from "react";
import { useStore, fieldValue } from "./engine/store";
import { adjustedCent, centStatus, REF_HUMIDITY, REF_TEMP } from "./engine/tuning";
import RecordForm from "./components/RecordForm";
import Stops from "./components/Stops";
import DeviationTable from "./components/DeviationTable";
import EnvPanel from "./components/EnvPanel";
import AbnormalPipes from "./components/AbnormalPipes";
import Reports from "./components/Reports";
import SyncCenter from "./components/SyncCenter";

const TABS = [
  { key: "record", label: "记录台" },
  { key: "stops", label: "音栓列表" },
  { key: "deviation", label: "调音偏差表" },
  { key: "env", label: "温湿度记录" },
  { key: "abnormal", label: "异常音管" },
  { key: "reports", label: "维护报告" },
  { key: "sync", label: "同步与设备" },
] as const;

export default function App() {
  const { state, store } = useStore();
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("record");

  const metrics = useMemo(() => {
    const stops = new Set(Object.values(state.pipes).map((p) => p.stopKey)).size;
    let overLimit = 0;
    for (const pipe of Object.values(state.pipes)) {
      const centStr = fieldValue(pipe, "cent");
      if (centStr === undefined || centStr.trim() === "") continue;
      const cent = Number(centStr);
      if (Number.isNaN(cent)) continue;
      const envId = state.latestEnvByVenue[pipe.venue];
      const env = state.envRecords.find((e) => e.id === envId);
      const temp = env ? env.temp : REF_TEMP;
      const humidity = env ? env.humidity : REF_HUMIDITY;
      if (centStatus(adjustedCent(cent, temp, humidity)) === "偏差超限") overLimit += 1;
    }
    const latestEnv = state.envRecords
      .slice()
      .sort((a, b) => b.ts - a.ts)[0];
    return {
      stops,
      overLimit,
      temp: latestEnv ? `${latestEnv.temp}°C` : "—",
      humidity: latestEnv ? `${latestEnv.humidity}%` : "—",
    };
  }, [state]);

  const pendingCount = state.outbox.length;

  return (
    <main className="app">
      <section className="hero">
        <p>管风琴维护 · 离线记录台</p>
        <h1>管风琴音管调音记录</h1>
        <span>
          管风琴间经常没有网络，几名技师在同一本维护工单上补记音栓、音管、音高、音分偏差和温湿度。
          每笔修改带设备序号与连续记录号，网络恢复后按音管与字段合并；同一字段两边都改过则保留两版，未确认前不能进入单次维护报告；
          音栓复检完成前关联异常音管不能解除；温湿度变化使旧偏差结论失效、报告自动标记重算；写盘失败或离线包损坏后已确认记录仍可读、未写入内容可重新提交，重复提交不重复增加维护次数。
        </span>
      </section>

      <section className="metrics">
        <article>
          <small>音栓数量</small>
          <strong>{metrics.stops}</strong>
        </article>
        <article>
          <small>偏差超限</small>
          <strong>{metrics.overLimit}</strong>
        </article>
        <article>
          <small>温度</small>
          <strong>{metrics.temp}</strong>
        </article>
        <article>
          <small>湿度</small>
          <strong>{metrics.humidity}</strong>
        </article>
      </section>

      {pendingCount > 0 && (
        <div className="sync-banner" onClick={() => setTab("sync")}>
          {state.online
            ? `网络已恢复：${pendingCount} 条离线记录待合并（按音管+字段，冲突保留两版）→ 前往同步与设备`
            : `离线模式：${pendingCount} 条记录保存在本机工单，网络恢复后合并 → 前往同步与设备`}
        </div>
      )}

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`tab ${tab === t.key ? "tab-active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.key === "sync" && pendingCount > 0 && <em className="tab-dot">{pendingCount}</em>}
          </button>
        ))}
      </nav>

      <section className="tab-body">
        {tab === "record" && (
          <RecordForm
            defaultVenue={state.devices.length ? "St.Mary's Church" : ""}
            onSave={(input) => {
              const res = store.saveRecord(input);
              return res;
            }}
          />
        )}
        {tab === "stops" && <Stops state={state} onReinspect={(k, r) => store.reinspect(k, r)} />}
        {tab === "deviation" && <DeviationTable state={state} />}
        {tab === "env" && (
          <EnvPanel
            state={state}
            defaultVenue="St.Mary's Church"
            onSave={(input) => store.saveEnv(input)}
          />
        )}
        {tab === "abnormal" && <AbnormalPipes state={state} onRelease={(id) => store.releasePipe(id)} />}
        {tab === "reports" && (
          <Reports
            state={state}
            onCreate={(v, t) => store.createReport(v, t)}
            onRecalc={(id) => store.recalcReport(id)}
          />
        )}
        {tab === "sync" && (
          <SyncCenter
            state={state}
            pkgStatus={store.pkgStatus}
            lastPersistFailed={store.lastPersistFailed}
            writeFailArmed={store.writeFailArmed}
            onMerge={() => store.mergeOutbox()}
            onAddDevice={() => store.addDevice()}
            onSetActive={(id) => store.setActiveDevice(id)}
            onSetOnline={(o) => store.setOnline(o)}
            onResolve={(p, f, opId) => store.resolveField(p, f, opId)}
            onConfirm={(id) => store.confirmPipe(id)}
            onConfirmAll={() => store.confirmAll()}
            onArmWriteFail={() => {
              store.armWriteFail();
            }}
            onCorrupt={() => store.corruptPackage()}
          />
        )}
      </section>

      <footer className="foot">
        离线记录台 · 设备序号 + 连续记录号 · 按音管/字段合并 · 两版冲突 · 确认后出报告 · 复检联动 · 温湿度失效重算 · 写盘/损坏兜底 · 幂等重提
      </footer>
    </main>
  );
}
