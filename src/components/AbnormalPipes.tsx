import { useState } from "react";
import type { State } from "../engine/types";
import { fieldValue } from "../engine/store";
import { Badge, Btn, Banner } from "./bits";

export default function AbnormalPipes({
  state,
  onRelease,
}: {
  state: State;
  onRelease: (pipeId: string) => { ok: boolean; reason?: string };
}) {
  const [blocked, setBlocked] = useState<string | null>(null);

  const abnormals = Object.values(state.pipes).filter(
    (p) => fieldValue(p, "abnormal") === "true"
  );

  const release = (pipeId: string) => {
    const res = onRelease(pipeId);
    if (!res.ok) setBlocked(res.reason ?? "操作被拦截");
    else setBlocked(null);
  };

  return (
    <div className="panel">
      <div className="heading">
        <div>
          <p>异常音管</p>
          <h2>异常标记与解除</h2>
        </div>
        <Badge tone="red">{abnormals.length} 根异常</Badge>
      </div>

      {blocked && (
        <Banner tone="red">
          <strong>解除被拦截：</strong>
          {blocked}
        </Banner>
      )}

      <div className="abnormal-list">
        {abnormals.map((pipe) => {
          const merged = state.reinspections.some((r) => r.stopKey === pipe.stopKey);
          const pending = state.outbox.some((o) => o.kind === "reinspect" && o.stopKey === pipe.stopKey);
          return (
            <article key={pipe.id} className="abnormal-card">
              <div className="abnormal-info">
                <h3>{pipe.id.split("||")[2]}</h3>
                <p>
                  {pipe.venue} · {pipe.stopName}
                </p>
                <p className="abnormal-detail">
                  音高 {fieldValue(pipe, "pitch") ?? "—"} · 偏差 {fieldValue(pipe, "cent") ?? "—"}cent · 簧片{" "}
                  {fieldValue(pipe, "reed") ?? "—"}
                </p>
                <p className="abnormal-note">{fieldValue(pipe, "note") ?? ""}</p>
              </div>
              <div className="abnormal-actions">
                {merged ? (
                  <Badge tone="green">复检已完成</Badge>
                ) : pending ? (
                  <Badge tone="amber">复检待合并</Badge>
                ) : (
                  <Badge tone="red">未复检</Badge>
                )}
                <Btn small danger onClick={() => release(pipe.id)} disabled={!merged}>
                  解除异常
                </Btn>
              </div>
            </article>
          );
        })}
        {abnormals.length === 0 && <p className="empty">当前没有异常音管。</p>}
      </div>
    </div>
  );
}
