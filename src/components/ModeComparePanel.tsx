// 锁量 vs 到场排队：同一组固定数据的并列对比（可接车辆 / 等待顺序 / 容量释放时刻）
import React, { useMemo } from 'react';
import { compareTransferModes, FIXED_SCENARIO, type ModeSimResult } from '../lib/transferSim';
import { fmtMin } from '../types';

function ModeTimeline({ title, subtitle, result }: { title: string; subtitle: string; result: ModeSimResult }) {
  return (
    <div className="plan-card">
      <div className="plan-head">
        <h4>{title}</h4>
        <div className="plan-sub">{subtitle}</div>
      </div>
      <div className="plan-kpis">
        <div className="kpi"><span className="kpi-num">{result.accepted.length}</span>辆被接纳</div>
        <div className="kpi"><span className="kpi-num">{result.receivedTon.toFixed(1)}</span>吨实收 / 容量 {result.capacityTon.toFixed(1)}</div>
        <div className="kpi">
          <span className="kpi-num">{result.releaseEvents.length > 0 ? fmtMin(result.releaseEvents[0].min) : '—'}</span>
          {result.releaseEvents.length > 0 ? '释放锁量' : '无锁量释放'}
        </div>
      </div>
      <table className="tbl small">
        <tbody>
          {result.events.map((e, i) => (
            <tr key={i}>
              <td className="mono" style={{ whiteSpace: 'nowrap' }}>{fmtMin(e.min)}</td>
              <td>{e.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {result.turnedAway.length > 0 && (
        <div className="bad small">未能接纳：{result.turnedAway.join('、')}（只能等下一窗口或改道）</div>
      )}
    </div>
  );
}

export function ModeComparePanel() {
  const cmp = useMemo(() => compareTransferModes(), []);
  const sc = FIXED_SCENARIO;
  return (
    <div className="panel">
      <h3>锁量 vs 到场排队 · 同组数据对比</h3>
      <div className="compare-summary">
        随题数据：转运站只剩 <b>{fmtMin(sc.windowStartMin)}–{fmtMin(sc.windowEndMin)}</b> 一个窗口、可接收{' '}
        <b>{sc.capacityTon.toFixed(1)} 吨</b>；T1 预计 <b>2.5</b> 吨（过磅实际 <b>1.8</b> 吨）、T2 预计 <b>2.0</b> 吨。
        两模式实收合计均为 <b>3.8 吨 ≤ 4.0 吨</b>（不超售）；实收只含过磅实称，估重 2.5/2.0 吨不登记为实收。
      </div>
      <div className="plan-grid">
        <ModeTimeline title="方式一 · 锁量（按预计吨位先锁窗）"
          subtitle="到场即有窗可卸，但估高占坑会暂时挡住后车；容量在过磅时刻才释放"
          result={cmp.lock} />
        <ModeTimeline title="方式二 · 到场排队（过磅后才扣实际容量）"
          subtitle="不锁量、先到先排；能接更多车，但司机等多久事前不可知"
          result={cmp.queue} />
      </div>
      <table className="tbl small" style={{ marginTop: 10 }}>
        <thead>
          <tr><th style={{ width: 110 }}>对比维度</th><th>锁量（先锁窗）</th><th>到场排队</th></tr>
        </thead>
        <tbody>
          {cmp.rows.map((r) => (
            <tr key={r.dimension}>
              <td><b>{r.dimension}</b></td>
              <td>{r.lock}</td>
              <td>{r.queue}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
