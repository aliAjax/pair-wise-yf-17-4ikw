import type { State } from "../engine/types";
import { adjustedCent, centStatus, REF_HUMIDITY, REF_TEMP } from "../engine/tuning";
import { fieldValue } from "../engine/store";
import { Badge } from "./bits";

export default function DeviationTable({ state }: { state: State }) {
  // 每个场馆取最新温湿度（以合并后的最新记录号为准）
  const envByVenue = new Map<string, { temp: number; humidity: number }>();
  for (const [venue, id] of Object.entries(state.latestEnvByVenue)) {
    const rec = state.envRecords.find((e) => e.id === id);
    if (rec) envByVenue.set(venue, { temp: rec.temp, humidity: rec.humidity });
  }

  const rows = Object.values(state.pipes)
    .map((pipe) => {
      const centStr = fieldValue(pipe, "cent");
      if (centStr === undefined || centStr.trim() === "") return null;
      const cent = Number(centStr);
      if (Number.isNaN(cent)) return null;
      const env = envByVenue.get(pipe.venue);
      const temp = env ? env.temp : REF_TEMP;
      const humidity = env ? env.humidity : REF_HUMIDITY;
      const adjusted = adjustedCent(cent, temp, humidity);
      const status = centStatus(adjusted);
      return {
        key: pipe.id,
        venue: pipe.venue,
        stopName: pipe.stopName,
        pipeId: pipe.id.split("||")[2],
        cent,
        temp,
        humidity,
        adjusted,
        status,
        hasEnv: !!env,
        pipeStatus: pipe.status,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => Math.abs(b.adjusted) - Math.abs(a.adjusted));

  return (
    <div className="panel">
      <div className="heading">
        <div>
          <p>调音偏差表</p>
          <h2>音分偏差（温湿度修正）</h2>
        </div>
        <Badge tone="blue">基准 {REF_TEMP}°C / {REF_HUMIDITY}%</Badge>
      </div>
      <div className="table-wrap">
        <table className="dev-table">
          <thead>
            <tr>
              <th>音管编号</th>
              <th>音栓</th>
              <th>场馆</th>
              <th>原始偏差</th>
              <th>温度</th>
              <th>湿度</th>
              <th>修正后</th>
              <th>状态</th>
              <th>记录状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="mono">{r.pipeId}</td>
                <td>{r.stopName}</td>
                <td>{r.venue}</td>
                <td className="num">{r.cent > 0 ? `+${r.cent}` : r.cent}</td>
                <td className="num">{r.hasEnv ? `${r.temp}°C` : "—"}</td>
                <td className="num">{r.hasEnv ? `${r.humidity}%` : "—"}</td>
                <td className="num strong">{r.adjusted > 0 ? `+${r.adjusted}` : r.adjusted}</td>
                <td>
                  <Badge tone={r.status === "偏差超限" ? "red" : "green"}>{r.status}</Badge>
                </td>
                <td>
                  {r.pipeStatus === "confirmed" ? (
                    <Badge tone="green">已确认</Badge>
                  ) : r.pipeStatus === "conflict" ? (
                    <Badge tone="red">冲突</Badge>
                  ) : (
                    <Badge tone="amber">待确认</Badge>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="empty">
                  暂无偏差记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
