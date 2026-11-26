// 站长工作台：调整窗口（时段/容量）、临时停收/恢复、切换锁量/排队模式、查看台账与两模式对比
import React, { useState } from 'react';
import type { Snapshot } from '../lib/db';
import type { Account, TransferStation, TransferWindow } from '../types';
import { fmtMin, parseMin } from '../types';
import {
  setCapacityMode, toggleWindowSuspend, updateWindow, windowLedger,
} from '../lib/transfer';
import { TransferBoard } from './TransferBoard';
import { ModeComparePanel } from './ModeComparePanel';
import { EventLogPanel, MODE_NAME } from './Shared';

function WindowEditor({
  snap, station, window, actor, onMsg,
}: {
  snap: Snapshot; station: TransferStation; window: TransferWindow; actor: string; onMsg: (m: string) => void;
}) {
  const [start, setStart] = useState(fmtMin(window.startMin));
  const [end, setEnd] = useState(fmtMin(window.endMin));
  const [cap, setCap] = useState(String(window.capacityTon));
  const [suspending, setSuspending] = useState(false);
  const [reason, setReason] = useState('设备检修');
  const ledger = windowLedger(window, snap.bookings);

  const save = async () => {
    const startMin = parseMin(start);
    const endMin = parseMin(end);
    const capacityTon = parseFloat(cap);
    if (isNaN(startMin) || isNaN(endMin) || isNaN(capacityTon)) {
      onMsg(`${window.id}：请输入合法的时刻（HH:MM）与容量`);
      return;
    }
    const r = await updateWindow(snap, station.id, window.id, { startMin, endMin, capacityTon }, actor);
    onMsg(r.ok
      ? `${station.name} ${window.id} 已调整为 ${start}–${end}、容量 ${capacityTon.toFixed(1)} 吨`
      : `调整被拒：${r.reason}`);
  };

  const suspend = async () => {
    await toggleWindowSuspend(snap, station.id, window.id, true, reason, actor);
    setSuspending(false);
    onMsg(`${station.name} ${window.id} 已临时停收（${reason}），在途预约成为线路上的真实阻塞`);
  };

  const resume = async () => {
    await toggleWindowSuspend(snap, station.id, window.id, false, '', actor);
    onMsg(`${station.name} ${window.id} 已恢复接收`);
  };

  return (
    <div className={`window-block ${window.suspended ? 'suspended' : ''}`}>
      <div className="veh-head">
        <b className="mono">{window.id}</b>
        {window.suspended
          ? <span className="badge red">临时停收{window.suspendReason ? `：${window.suspendReason}` : ''}</span>
          : <span className="badge green">接收中</span>}
        <span className="muted small">
          已锁(估) {ledger.lockedTon.toFixed(1)}t · 已卸实收 {ledger.receivedTon.toFixed(1)}t · 剩余 {ledger.availableTon.toFixed(1)}t
        </span>
      </div>
      <div className="btn-row">
        <label className="small">开始 <input className="input mini" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label className="small">结束 <input className="input mini" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
        <label className="small">容量(吨) <input className="input mini" type="number" step="0.5" min="0" value={cap} onChange={(e) => setCap(e.target.value)} /></label>
        <button className="btn small primary" onClick={save}>保存窗口</button>
        {!window.suspended && !suspending && (
          <button className="btn small" onClick={() => setSuspending(true)}>临时停收…</button>
        )}
        {window.suspended && (
          <button className="btn small primary" onClick={resume}>恢复接收</button>
        )}
      </div>
      {suspending && !window.suspended && (
        <div className="btn-row">
          <input className="input" style={{ maxWidth: 260 }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="停收原因" />
          <button className="btn small primary" onClick={suspend}>确认停收</button>
          <button className="btn small ghost" onClick={() => setSuspending(false)}>取消</button>
        </div>
      )}
      <div className="muted tiny">
        校验：容量不得调到低于「已锁(估)+已卸实收」（当前 {station.mode === 'lock' ? (ledger.lockedTon + ledger.receivedTon).toFixed(1) : ledger.receivedTon.toFixed(1)} 吨），否则等同超售，将被拒绝。
      </div>
    </div>
  );
}

export function MasterView({ snap, account }: { snap: Snapshot; account: Account }) {
  const [msg, setMsg] = useState('');

  return (
    <div className="layout">
      <div className="col-left">
        <div className="panel">
          <h3>窗口管理（站长）</h3>
          <p className="muted small">
            调整窗口时段与容量、临时停收/恢复。任何调整都不得让「已锁(估)+已卸实收」超过容量——不超售是硬约束。
          </p>
          {msg && <div className="demo-msg">{msg}</div>}
          {snap.transferStations.map((st) => (
            <div key={st.id} className="veh-block">
              <div className="veh-head">
                <b>{st.name}</b>
                <span className="tag">{MODE_NAME[st.mode]}</span>
              </div>
              {st.windows.map((w) => (
                <WindowEditor key={`${w.id}-${w.startMin}-${w.endMin}-${w.capacityTon}-${w.suspended}`}
                  snap={snap} station={st} window={w} actor={account.name} onMsg={setMsg} />
              ))}
            </div>
          ))}
        </div>

        {snap.transferStations.map((st) => (
          <div className="panel" key={st.id}>
            <h3>{st.name} · 容量台账与预约队列</h3>
            <TransferBoard snap={snap} stationId={st.id} />
          </div>
        ))}

        <ModeComparePanel />
      </div>

      <div className="col-right">
        <div className="panel">
          <h3>容量模式切换</h3>
          <p className="muted small">
            锁量：按预计吨位先锁窗，到场即有窗可卸，但估高占坑会挡住后车，容量在过磅时刻才释放。
            排队：不锁量、先到先排，过磅才扣实际容量，能接更多车，但司机等多久事前不可知。
          </p>
          {snap.transferStations.map((st) => (
            <div key={st.id} className="veh-block">
              <div className="veh-head"><b>{st.name}</b><span className="tag">{MODE_NAME[st.mode]}</span></div>
              <div className="btn-row">
                <button className="btn small" disabled={st.mode === 'lock'}
                  onClick={async () => { await setCapacityMode(snap, st.id, 'lock', account.name); setMsg(`${st.name} 已切换为锁量模式，预约按估重重新锁窗`); }}>
                  切为锁量模式
                </button>
                <button className="btn small" disabled={st.mode === 'queue'}
                  onClick={async () => { await setCapacityMode(snap, st.id, 'queue', account.name); setMsg(`${st.name} 已切换为到场排队模式，锁量全部释放`); }}>
                  切为到场排队
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="panel">
          <h3>硬规则</h3>
          <ul className="small muted rules">
            <li>任何模式都不得超售：锁量模式「已锁(估)+实收 ≤ 容量」；排队模式「实收 ≤ 容量」。过磅超余量一律拒收。</li>
            <li>估重不能登记成已卸实收：台账“实收”只累计过磅实称；估重仅用于锁窗。</li>
            <li>临时停收期间到场/过磅一律拒绝，在途预约成为线路上的真实阻塞，由调度安排等待或改道。</li>
          </ul>
        </div>

        <EventLogPanel events={snap.events} />
      </div>
    </div>
  );
}
