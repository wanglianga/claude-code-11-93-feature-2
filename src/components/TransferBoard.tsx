// 转运站窗口台账 + 预约队列展示（站长 / 调度员共用）
import React, { useState } from 'react';
import type { Snapshot } from '../lib/db';
import type { Account, Booking, TransferStation, TransferWindow } from '../types';
import { fmtMin } from '../types';
import {
  affectedBookings, issueInstruction, queuePosition, windowLedger, type AffectedBooking,
} from '../lib/transfer';
import { BookingBadge, MODE_NAME, VEHICLE_COLORS } from './Shared';

export function LedgerBar({ window, bookings }: { window: TransferWindow; bookings: Booking[] }) {
  const ledger = windowLedger(window, bookings);
  const cap = window.capacityTon || 1;
  const recvPct = Math.min(100, (ledger.receivedTon / cap) * 100);
  const lockPct = Math.min(100 - recvPct, (ledger.lockedTon / cap) * 100);
  return (
    <div className="ledger">
      <div className="ledger-bar">
        <div className="ledger-recv" style={{ width: `${recvPct}%` }} title={`已卸实收 ${ledger.receivedTon.toFixed(1)} 吨`} />
        <div className="ledger-lock" style={{ width: `${lockPct}%` }} title={`已锁(估) ${ledger.lockedTon.toFixed(1)} 吨`} />
      </div>
      <div className="ledger-legend small">
        <span><i className="dot recv" />已卸实收 {ledger.receivedTon.toFixed(1)}t</span>
        <span><i className="dot lock" />已锁(估) {ledger.lockedTon.toFixed(1)}t</span>
        <span className="muted">剩余可接收 {ledger.availableTon.toFixed(1)}t / 容量 {ledger.capacityTon.toFixed(1)}t</span>
      </div>
    </div>
  );
}

export function WindowBookings({ snap, station, window }: { snap: Snapshot; station: TransferStation; window: TransferWindow }) {
  const rows = snap.bookings
    .filter((b) => b.windowId === window.id && b.stationId === station.id)
    .slice()
    .sort((a, b) => (a.queueNo ?? 90) - (b.queueNo ?? 90) || a.createdAtMin - b.createdAtMin || a.id.localeCompare(b.id));
  return (
    <table className="tbl small">
      <thead>
        <tr>
          <th>预约</th><th>车辆</th><th>估重(锁)</th><th>实称(实收)</th><th>状态</th>
          {station.mode === 'queue' && <th>排队</th>}<th>时刻</th><th>备注</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((b) => {
          const pos = queuePosition(window, snap.bookings, b.id);
          return (
            <tr key={b.id} className={b.status === 'weighed' ? 'row-done' : ''}>
              <td className="mono small">{b.id}</td>
              <td><span className="veh-dot" style={{ background: VEHICLE_COLORS[b.vehicleId] ?? '#666' }} />{b.vehicleId}</td>
              <td className="mono">{b.estTon.toFixed(1)}t</td>
              <td className="mono">{b.actualTon != null ? `${b.actualTon.toFixed(1)}t` : '—'}</td>
              <td><BookingBadge status={b.status} /></td>
              {station.mode === 'queue' && <td className="mono">{pos != null ? `第 ${pos} 位` : '—'}</td>}
              <td className="mono small">
                {b.weighedAtMin != null ? `过磅 ${fmtMin(b.weighedAtMin)}` : b.arrivedAtMin != null ? `到场 ${fmtMin(b.arrivedAtMin)}` : `预约 ${fmtMin(b.createdAtMin)}`}
              </td>
              <td className="small muted">{b.note ?? ''}</td>
            </tr>
          );
        })}
        {rows.length === 0 && <tr><td colSpan={8} className="muted">本窗口暂无预约</td></tr>}
      </tbody>
    </table>
  );
}

export function TransferBoard({ snap, stationId }: { snap: Snapshot; stationId: string }) {
  const station = snap.transferStations.find((s) => s.id === stationId);
  if (!station) return null;
  return (
    <div className="transfer-board">
      <div className="veh-head">
        <b>{station.name}</b>
        <span className="tag">{MODE_NAME[station.mode]}</span>
        <span className="muted small">过磅作业 {station.weighMin} 分钟/车</span>
      </div>
      {station.windows.map((w) => (
        <div key={w.id} className={`window-block ${w.suspended ? 'suspended' : ''}`}>
          <div className="veh-head">
            <b className="mono">{w.id}</b>
            <span className="mono">{fmtMin(w.startMin)}–{fmtMin(w.endMin)}</span>
            <span className="mono">容量 {w.capacityTon.toFixed(1)}t</span>
            {w.suspended
              ? <span className="badge red">临时停收{w.suspendReason ? `：${w.suspendReason}` : ''}</span>
              : <span className="badge green">接收中</span>}
          </div>
          <LedgerBar window={w} bookings={snap.bookings} />
          <WindowBookings snap={snap} station={station} window={w} />
        </div>
      ))}
    </div>
  );
}

// ===================== 调度员：转运站队列与受影响站点 =====================

function AffectedRow({
  snap, account, affected, onMsg,
}: {
  snap: Snapshot; account: Account; affected: AffectedBooking; onMsg: (m: string) => void;
}) {
  const { booking, station, window, reason, affectedStations } = affected;
  const target = snap.transferStations.find((s) => s.id !== station.id);
  const targetWindow = target?.windows.find((w) => !w.suspended);

  const sendWait = async () => {
    await issueInstruction(snap, {
      vehicleId: booking.vehicleId, kind: 'wait', stationId: station.id,
      message: `请在 ${station.name} 等待：${window.id} 窗口容量释放或恢复接收后立即补锁/过磅`,
    }, account.name);
    onMsg(`已向 ${booking.vehicleId} 发出等待安排`);
  };

  const sendDivert = async () => {
    if (!target || !targetWindow) return;
    await issueInstruction(snap, {
      vehicleId: booking.vehicleId, kind: 'divert', stationId: station.id,
      targetStationId: target.id, windowId: targetWindow.id,
      message: `${station.name} ${window.id} 受阻，请改道 ${target.name} ${targetWindow.id}（${fmtMin(targetWindow.startMin)}–${fmtMin(targetWindow.endMin)}，容量 ${targetWindow.capacityTon.toFixed(1)} 吨）`,
    }, account.name);
    onMsg(`已向 ${booking.vehicleId} 发出改道安排（→ ${target.name}），待司机确认`);
  };

  return (
    <tr>
      <td><span className="veh-dot" style={{ background: VEHICLE_COLORS[booking.vehicleId] ?? '#666' }} />{booking.vehicleId}</td>
      <td className="mono small">{booking.id}（估 {booking.estTon.toFixed(1)}t）</td>
      <td className="small">{reason}</td>
      <td className="small">
        {affectedStations.length > 0
          ? affectedStations.map((s) => `${s.id} ${s.name}（止 ${fmtMin(s.deadlineMin)}）`).join('、')
          : '线路上无未完成站点'}
      </td>
      <td className="actions">
        <button className="btn small" onClick={sendWait}>通知等待</button>
        <button className="btn small" disabled={!targetWindow} onClick={sendDivert}>
          安排改道{target ? `（→${target.name}）` : ''}
        </button>
      </td>
    </tr>
  );
}

export function TransferDispatchPanel({ snap, account }: { snap: Snapshot; account: Account }) {
  const [msg, setMsg] = useState('');
  const affected = affectedBookings(snap);
  const recentInstr = snap.instructions.slice().reverse().slice(0, 6);

  return (
    <div className="panel">
      <h3>转运站队列与受影响站点</h3>
      {msg && <div className="demo-msg">{msg}</div>}
      {snap.transferStations.map((st) => (
        <TransferBoard key={st.id} snap={snap} stationId={st.id} />
      ))}

      <h4>受阻预约与受影响站点（{affected.length}）</h4>
      <table className="tbl small">
        <thead>
          <tr><th>车辆</th><th>预约</th><th>受阻原因</th><th>受影响站点（线路未完成）</th><th>安排</th></tr>
        </thead>
        <tbody>
          {affected.map((a) => (
            <AffectedRow key={a.booking.id} snap={snap} account={account} affected={a} onMsg={setMsg} />
          ))}
          {affected.length === 0 && (
            <tr><td colSpan={5} className="muted">当前无受阻预约：窗口容量与接收状态可覆盖全部在途预约。</td></tr>
          )}
        </tbody>
      </table>

      {recentInstr.length > 0 && (
        <>
          <h4>已发出的安排</h4>
          <table className="tbl small">
            <thead><tr><th>时刻</th><th>车辆</th><th>类型</th><th>内容</th><th>状态</th></tr></thead>
            <tbody>
              {recentInstr.map((i) => (
                <tr key={i.id}>
                  <td className="mono">{fmtMin(i.createdAtMin)}</td>
                  <td>{i.vehicleId}</td>
                  <td>{i.kind === 'wait' ? '等待' : '改道'}</td>
                  <td className="small">{i.message}</td>
                  <td>{i.acked ? <span className="badge green">司机已确认</span> : <span className="badge orange">待确认</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
