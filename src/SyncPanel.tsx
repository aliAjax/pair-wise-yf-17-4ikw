import { useState } from "react";
import { useStore } from "./useStore";
import { Badge, fmtTime } from "./ui";

/** 网络与韧性演练：设备切换、联网同步、离线包摆渡、写盘故障 / 坏包恢复 */
export function SyncPanel() {
  const store = useStore();
  const { devices, currentDeviceId, online, corruptKeys, rejectedDuplicates, lastSyncAt } = store.state;
  const [failures, setFailures] = useState(1);
  const [importText, setImportText] = useState("");
  const [exportText, setExportText] = useState("");

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>网络与存储</p>
          <h2>同步、摆渡与故障恢复</h2>
        </div>
        <Badge tone={online ? "green" : "amber"}>{online ? "网络在线" : "现场离线"}</Badge>
      </div>

      <div className="ops-grid">
        <div className="ops-card">
          <h3>记录台（设备序号）</h3>
          <p className="muted small">
            两名技师各用一台记录台；切换后只看本机未同步队列，工单视图共享。
          </p>
          <div className="device-row">
            {devices.map((d) => (
              <button
                key={d.id}
                className={d.id === currentDeviceId ? "tab active" : "tab"}
                onClick={() => store.switchDevice(d.id)}
              >
                {d.id} · {d.tech}
              </button>
            ))}
          </div>
        </div>

        <div className="ops-card">
          <h3>网络恢复与同步</h3>
          <p className="muted small">
            已确认记录按批次 id 幂等并入，重复提交不重复增加维护次数；合并键为「音管 + 字段」。
          </p>
          <div className="device-row">
            <button className={online ? "tab" : "tab active"} onClick={() => store.setOnline(false)}>
              断网（现场）
            </button>
            <button className={online ? "tab active" : "tab"} onClick={() => store.setOnline(true)}>
              恢复网络
            </button>
            <button className="primary" disabled={!online} onClick={() => store.sync()}>
              立即同步
            </button>
          </div>
          <p className="muted small">
            上次同步：{lastSyncAt ? fmtTime(lastSyncAt) : "—"} ·
            累计拦截重复提交：{rejectedDuplicates} 次 ·
            工单记录笔数（去重）：{store.maintenanceCount()}
          </p>
        </div>

        <div className="ops-card">
          <h3>离线包摆渡（U 盘 / 内网）</h3>
          <p className="muted small">包带校验和，损坏整包拒绝，已确认记录不受影响。</p>
          <button
            onClick={() => {
              setExportText(store.exportOfflinePackage());
            }}
          >
            导出现有工单为离线包
          </button>
          {exportText && (
            <textarea readOnly rows={3} value={exportText} onFocus={(e) => e.target.select()} />
          )}
          <textarea
            rows={3}
            placeholder="粘贴另一台记录台导出的离线包 JSON"
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
          />
          <button
            className="primary"
            disabled={!importText.trim()}
            onClick={() => {
              store.importOfflinePackage(importText);
              setImportText("");
            }}
          >
            导入并按音管/字段合并
          </button>
        </div>

        <div className="ops-card danger-card">
          <h3>故障演练</h3>
          <p className="muted small">
            模拟写盘失败或离线包损坏：已确认记录仍可读，未写入内容可重新提交。
          </p>
          <div className="device-row">
            <label className="inline">
              连续失败
              <input
                type="number"
                min={1}
                max={9}
                value={failures}
                onChange={(e) => setFailures(Math.max(1, Number(e.target.value) || 1))}
              />
              次写盘
            </label>
            <button onClick={() => store.setFailureInjection(failures)}>
              注入写盘故障
            </button>
            <button onClick={() => store.corruptOneServerBatch()}>
              损坏一条已并入记录
            </button>
            <button onClick={() => store.rebuildIndexes()} disabled={corruptKeys.length === 0}>
              重建索引隔离坏条
            </button>
          </div>
          {corruptKeys.length > 0 && (
            <div className="corrupt-list">
              <Badge tone="red">{corruptKeys.length} 条损坏已隔离</Badge>
              <ul>
                {corruptKeys.map((k) => (
                  <li key={k} className="muted small">{k}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
