import { useStore } from "./useStore";
import { Badge, batchTag, describeEntry, fmtTime } from "./ui";

/** 本机记录队列：未确认（可改写/作废/确认）与已确认待同步（只读、可重发） */
export function Outbox() {
  const store = useStore();
  const { drafts, localConfirmed, memoryOnly, online } = store.state;

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>本机记录台 {store.state.currentDeviceId}</p>
          <h2>记录队列与续作</h2>
        </div>
        <div className="queue-counts">
          <Badge tone="amber">未确认 {drafts.length}</Badge>
          <Badge tone="blue">已确认待同步 {localConfirmed.length}</Badge>
        </div>
      </div>

      <h3>未确认记录（不会进入维护报告）</h3>
      {drafts.length === 0 && <p className="muted">暂无。现场补记会先落在这里。</p>}
      <div className="batch-list">
        {drafts.map((b) => {
          const mem = memoryOnly.has(b.id);
          return (
            <article key={b.id} className={mem ? "batch memory-only" : "batch"}>
              <header>
                <strong>{batchTag(b)}</strong>
                <span className="muted">{fmtTime(b.at)} · {b.tech}</span>
                {mem && <Badge tone="red">仅内存 · 未写入</Badge>}
              </header>
              <ul>
                {b.entries.map((e, i) => (
                  <li key={i}>{describeEntry(e)}</li>
                ))}
                {b.resolution && (
                  <li className="resolution-line">
                    冲突裁决：{b.resolution.pipeId} · {b.resolution.field} 选定 {b.resolution.chosenVersion}
                  </li>
                )}
              </ul>
              <footer>
                {mem ? (
                  <>
                    <button className="primary" onClick={() => store.rewriteDraft(b.id)}>
                      重新写入
                    </button>
                    <button onClick={() => store.discardDraft(b.id)}>放弃内容</button>
                  </>
                ) : (
                  <>
                    <button className="primary" onClick={() => store.confirmDraft(b.id)}>
                      确认
                    </button>
                    <button onClick={() => store.discardDraft(b.id)}>作废</button>
                  </>
                )}
              </footer>
            </article>
          );
        })}
      </div>

      <h3>已确认记录{online ? "（同步后并入工单）" : "（离线期间锁定，恢复网络后自动续传）"}</h3>
      {localConfirmed.length === 0 && <p className="muted">暂无已确认记录。</p>}
      <div className="batch-list">
        {localConfirmed.map((b) => (
          <article key={b.id} className="batch confirmed">
            <header>
              <strong>{batchTag(b)}</strong>
              <Badge tone="green">已确认 · 只读</Badge>
              <span className="muted">{fmtTime(b.at)} · {b.tech}</span>
            </header>
            <ul>
              {b.entries.map((e, i) => (
                <li key={i}>{describeEntry(e)}</li>
              ))}
              {b.resolution && (
                <li className="resolution-line">
                  冲突裁决：{b.resolution.pipeId} · {b.resolution.field} 选定 {b.resolution.chosenVersion}
                </li>
              )}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}
