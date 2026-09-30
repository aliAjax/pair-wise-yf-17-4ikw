import { useMemo } from "react";
import { useStore } from "./useStore";
import { Badge } from "./ui";
import { fieldLabel, climateStale, CLIMATE_TEMP_TOL, CLIMATE_HUM_TOL } from "./merge";
import { FIELD_LABEL, versionKey } from "./types";

/** 网络恢复后的工单合并视图：音栓、音管字段、双版本冲突、复检守卫、气候失效 */
export function MergedView() {
  const store = useStore();
  const m = useMemo(() => store.merged(), [store.state.serverBatches]);
  const pipes = [...m.pipes.values()];
  const stops = [...m.stops.values()];

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>合并视图 · 按音管 + 字段归并</p>
          <h2>工单 WO-2026-StMary</h2>
          <small className="muted">
            同一字段两边都改过且互不可见时保留两版；因果覆盖只留新版。
          </small>
        </div>
        <div className="queue-counts">
          <Badge tone="brown">音栓 {m.stops.size}</Badge>
          <Badge tone="blue">音管 {m.pipes.size}</Badge>
          <Badge tone={m.conflicts.length ? "red" : "green"}>
            待裁决冲突 {m.conflicts.filter((c) => !c.resolution).length}
          </Badge>
        </div>
      </div>

      <div className="climate-strip">
        <div>
          <span>当前温湿度</span>
          <strong>
            {m.climate ? `${m.climate.temperature}°C / ${m.climate.humidity}%` : "未记录"}
          </strong>
          {m.climate?.note && <em>{m.climate.note}</em>}
        </div>
        <p className="muted">
          偏差结论绑定记录时气候；超出 ±{CLIMATE_TEMP_TOL}°C / ±{CLIMATE_HUM_TOL}% 即标红失效。
        </p>
      </div>

      {m.conflicts.length > 0 && (
        <div className="conflict-box">
          <h3>双版本冲突（两名技师同时保存）</h3>
          {m.conflicts.map((c) => {
            const resolved = !!c.resolution;
            return (
              <article key={c.pipeId + c.field} className="conflict">
                <header>
                  <strong>
                    {c.pipeId} · {fieldLabel(c.field)}
                  </strong>
                  {resolved ? (
                    <Badge tone="green">
                      已裁决采用 {c.resolution!.chosenVersion}
                    </Badge>
                  ) : (
                    <Badge tone="red">未裁决 · 两版并存</Badge>
                  )}
                </header>
                <div className="versions">
                  {c.versions.map((v) => {
                    const chosen = c.resolution?.chosenVersion === versionKey(v.deviceId, v.seq);
                    return (
                      <div key={versionKey(v.deviceId, v.seq)} className={chosen ? "version chosen" : "version"}>
                        <code>{versionKey(v.deviceId, v.seq)}</code>
                        <b>{v.value}</b>
                        <span className="muted">{v.tech}</span>
                        {v.climate && (
                          <span className="muted">
                            · 记录于 {v.climate.temperature}°C/{v.climate.humidity}%
                            {climateStale(v.climate, m.climate) && (
                              <Badge tone="red">气候已变，结论失效</Badge>
                            )}
                          </span>
                        )}
                        {!resolved && (
                          <button
                            onClick={() => {
                              const dev = store.state.devices.find(
                                (d) => d.id === store.state.currentDeviceId
                              );
                              store.resolveConflict(
                                dev?.tech ?? "技师",
                                c.pipeId,
                                c.field,
                                versionKey(v.deviceId, v.seq)
                              );
                            }}
                          >
                            采用此版（生成带记录号的裁决）
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {stops.map((s) => {
        const members = pipes.filter((p) => p.stopId === s.stopId);
        return (
          <div key={s.stopId} className="stop-block">
            <h3>
              {s.name ?? s.stopId} <code>{s.stopId}</code>
              {s.recheckDone ? (
                <Badge tone="green">复检完成</Badge>
              ) : (
                <Badge tone="amber">复检未完成</Badge>
              )}
            </h3>
            <table className="pipe-table">
              <thead>
                <tr>
                  <th>音管</th>
                  {(["pitch", "cent", "reed", "note"] as const).map((f) => (
                    <th key={f}>{FIELD_LABEL[f]}</th>
                  ))}
                  <th>异常状态</th>
                </tr>
              </thead>
              <tbody>
                {members.map((p) => {
                  const centStale = climateStale(p.fields.cent?.climate, m.climate);
                  return (
                    <tr key={p.pipeId} className={p.abnormal ? "row-abnormal" : ""}>
                      <td>
                        <code>{p.pipeId}</code>
                        <div className="muted small">
                          维护 {store.pipeMaintenanceCount(p.pipeId)} 次
                        </div>
                      </td>
                      {(["pitch", "cent", "reed", "note"] as const).map((f) => (
                        <td key={f}>
                          {p.fields[f]?.value ?? "—"}
                          {p.conflicts.includes(f) && (
                            <Badge tone="red">
                              两版{p.fields[f] && `· 显示 ${versionKey(p.fields[f]!.deviceId, p.fields[f]!.seq)}`}
                            </Badge>
                          )}
                          {f === "cent" && centStale && p.fields.cent && (
                            <Badge tone="red">偏差结论失效</Badge>
                          )}
                        </td>
                      ))}
                      <td>
                        {p.abnormal ? (
                          <>
                            <Badge tone="red">异常</Badge>
                            {p.abnormalReason && <span className="muted small"> {p.abnormalReason}</span>}
                          </>
                        ) : p.released ? (
                          <Badge tone="green">复检后已解除</Badge>
                        ) : (
                          <span className="muted">正常</span>
                        )}
                        {p.releaseBlocked && (
                          <div className="blocked">
                            <Badge tone="amber">解除被拦截</Badge>
                            <span className="muted small">
                              音栓复检完成前异常不能解除（申请 {versionKey(p.releaseBlocked.deviceId, p.releaseBlocked.seq)} 挂起）
                            </span>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {members.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">该音栓下暂无音管记录</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        );
      })}
    </section>
  );
}
