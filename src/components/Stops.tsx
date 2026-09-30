import { useState } from "react";
import type { State } from "../engine/types";
import { deviceName, fieldValue, stopKeyOf } from "../engine/store";
import { Badge, Btn } from "./bits";

const REINSPECT_RESULTS = ["复检合格", "需维修", "复检完成"];

export default function Stops({ state, onReinspect }: { state: State; onReinspect: (stopKey: string, result: string) => void }) {
  const [resultByStop, setResultByStop] = useState<Record<string, string>>({});
  const [, setTick] = useState(0);

  // 按场馆+音栓聚合
  const stops = new Map<string, { venue: string; stopName: string; stopType: string; pipes: string[] }>();
  for (const pipe of Object.values(state.pipes)) {
    const key = pipe.stopKey;
    const cur = stops.get(key) ?? { venue: pipe.venue, stopName: pipe.stopName, stopType: pipe.stopType, pipes: [] };
    cur.pipes.push(pipe.id);
    stops.set(key, cur);
  }

  const reinspected = new Set(state.reinspections.map((r) => r.stopKey));
  const pendingReinspect = new Set(
    state.outbox.filter((o) => o.kind === "reinspect").map((o) => o.stopKey as string)
  );

  return (
    <div className="panel">
      <div className="heading">
        <div>
          <p>音栓列表</p>
          <h2>音栓与复检状态</h2>
        </div>
        <Badge tone="blue">共 {stops.size} 个音栓</Badge>
      </div>
      <div className="stop-list">
        {[...stops.entries()].map(([key, s]) => {
          const done = reinspected.has(key);
          const pending = !done && pendingReinspect.has(key);
          const result = resultByStop[key] ?? REINSPECT_RESULTS[0];
          const abnormalCount = s.pipes.filter((pid) => fieldValue(state.pipes[pid], "abnormal") === "true").length;
          return (
            <article key={key} className="stop-card">
              <div className="stop-head">
                <div>
                  <h3>{s.stopName}</h3>
                  <p>
                    {s.venue} · {s.stopType} · {s.pipes.length} 根音管
                    {abnormalCount > 0 && <span className="stop-abnormal"> · {abnormalCount} 根异常</span>}
                  </p>
                </div>
                {done ? (
                  <Badge tone="green">已复检</Badge>
                ) : pending ? (
                  <Badge tone="amber">复检记录待合并</Badge>
                ) : (
                  <Badge tone="red">未复检</Badge>
                )}
              </div>
              {!done && (
                <div className="stop-actions">
                  <select
                    value={result}
                    onChange={(e) => setResultByStop({ ...resultByStop, [key]: e.target.value })}
                  >
                    {REINSPECT_RESULTS.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                  <Btn
                    small
                    primary
                    onClick={() => {
                      onReinspect(key, result);
                      setTick((t) => t + 1);
                    }}
                  >
                    完成音栓复检
                  </Btn>
                  <span className="stop-hint">复检完成后，关联异常音管才能解除</span>
                </div>
              )}
              {done && (
                <p className="stop-last">
                  最近复检：
                  {state.reinspections
                    .filter((r) => r.stopKey === key)
                    .sort((a, b) => b.ts - a.ts)[0]
                    ?.result ?? ""}
                  （{deviceName(state, state.reinspections.filter((r) => r.stopKey === key).sort((a, b) => b.ts - a.ts)[0]?.deviceId ?? "")}
                </p>
              )}
            </article>
          );
        })}
        {stops.size === 0 && <p className="empty">暂无音栓，请先在记录台补记。</p>}
      </div>
    </div>
  );
}
