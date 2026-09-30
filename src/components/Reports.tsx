import { useState } from "react";
import type { State } from "../engine/types";
import { deviceName } from "../engine/store";
import { Badge, Btn, Banner, Field } from "./bits";

export default function Reports({
  state,
  onCreate,
  onRecalc,
}: {
  state: State;
  onCreate: (venue: string, title: string) => { ok: boolean; reason?: string; blocked?: string[] };
  onRecalc: (id: string) => void;
}) {
  const venues = [...new Set(Object.values(state.pipes).map((p) => p.venue))];
  const [venue, setVenue] = useState(venues[0] ?? "");
  const [title, setTitle] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [blockedList, setBlockedList] = useState<string[]>([]);

  const submit = () => {
    const res = onCreate(venue, title.trim() || "单次维护报告");
    if (!res.ok) {
      setErr(res.reason ?? "生成失败");
      setBlockedList(res.blocked ?? []);
    } else {
      setErr(null);
      setBlockedList([]);
      setTitle("");
    }
  };

  const pendingReport = state.outbox.filter((o) => o.kind === "report");

  return (
    <div className="panel">
      <div className="heading">
        <div>
          <p>单次维护报告</p>
          <h2>报告生成与重算</h2>
        </div>
        <Badge tone="blue">维护次数 {state.maintenanceCount}</Badge>
      </div>

      <div className="report-create">
        <Field label="场馆">
          <select value={venue} onChange={(e) => setVenue(e.target.value)}>
            {venues.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </Field>
        <Field label="报告标题">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如 单次维护报告" />
        </Field>
        <div className="env-submit">
          <Btn primary onClick={submit} disabled={!venues.length}>
            生成单次维护报告
          </Btn>
        </div>
      </div>

      {err && (
        <Banner tone="red">
          <strong>未确认前不能进入单次维护报告：</strong>
          {err}
          {blockedList.length > 0 && <span>（待确认音管：{blockedList.join("、")}）</span>}
        </Banner>
      )}

      {pendingReport.length > 0 && (
        <Banner tone="amber">
          {pendingReport.length} 份报告已在离线工单中，网络合并后正式生成，维护次数届时增加。
        </Banner>
      )}

      <div className="report-list">
        {[...state.reports]
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((r) => (
            <article key={r.id} className="report-card">
              <div className="report-head">
                <div>
                  <h3>{r.title}</h3>
                  <p>
                    {r.venue} · {new Date(r.createdAt).toLocaleString("zh-CN")} · {deviceName(state, r.createdBy)}
                  </p>
                </div>
                {r.stale ? <Badge tone="red">偏差结论已失效</Badge> : <Badge tone="green">结论有效</Badge>}
              </div>

              {r.stale && (
                <Banner tone="amber">
                  温湿度已变化，本报告偏差结论基于旧环境读数，需要重算。
                  <span className="banner-action">
                    <Btn small primary onClick={() => onRecalc(r.id)}>
                      按最新温湿度重算
                    </Btn>
                  </span>
                </Banner>
              )}

              <table className="dev-table">
                <thead>
                  <tr>
                    <th>音管</th>
                    <th>原始偏差</th>
                    <th>修正后偏差</th>
                    <th>结论</th>
                  </tr>
                </thead>
                <tbody>
                  {r.conclusions.map((c) => (
                    <tr key={c.pipeId}>
                      <td className="mono">{c.pipeId.split("||")[2]}</td>
                      <td className="num">{c.cent > 0 ? `+${c.cent}` : c.cent}</td>
                      <td className="num strong">{c.adjustedCent > 0 ? `+${c.adjustedCent}` : c.adjustedCent}</td>
                      <td>
                        <Badge tone={c.status === "偏差超限" ? "red" : "green"}>{c.status}</Badge>
                      </td>
                    </tr>
                  ))}
                  {r.conclusions.length === 0 && (
                    <tr>
                      <td colSpan={4} className="empty">
                        本报告无偏差记录
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              <p className="report-snapshot">
                报告环境快照：
                {r.envSnapshot ? `${r.envSnapshot.temp}°C / ${r.envSnapshot.humidity}%` : "无温湿度读数（按基准 20°C / 50%）"}
              </p>
            </article>
          ))}
        {state.reports.length === 0 && <p className="empty">尚未生成维护报告。</p>}
      </div>
    </div>
  );
}
