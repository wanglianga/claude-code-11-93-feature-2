// 应用外壳：登录会话 + 顶栏（模拟时钟）+ 角色视图
import React, { useEffect, useState } from 'react';
import type { Account } from './types';
import { fmtMin } from './types';
import { useWorld } from './state/WorldContext';
import { advanceClock } from './lib/actions';
import { Login } from './components/Login';
import { DispatcherView } from './components/DispatcherView';
import { DriverView } from './components/DriverView';
import { CsView } from './components/CsView';
import { MasterView } from './components/MasterView';

const SESSION_KEY = 'sw-session';
const ROLE_NAME: Record<string, string> = { dispatcher: '调度员', driver: '司机', cs: '客服', master: '站长' };

function Shell() {
  const { snap } = useWorld();
  const [account, setAccount] = useState<Account | null>(() => {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? (JSON.parse(raw) as Account) : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (account) localStorage.setItem(SESSION_KEY, JSON.stringify(account));
    else localStorage.removeItem(SESSION_KEY);
  }, [account]);

  if (!account) return <Login onLogin={setAccount} />;
  if (!snap) return <div className="loading">正在从 IndexedDB 加载数据…</div>;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">🚛 环卫线路工作台</div>
        <div className="clock">
          <span className="mono clock-num">{fmtMin(snap.nowMin)}</span>
          <button className="btn tiny" onClick={() => advanceClock(1, account.name)}>+1分</button>
          <button className="btn tiny" onClick={() => advanceClock(5, account.name)}>+5分</button>
          <button className="btn tiny" onClick={() => advanceClock(10, account.name)}>+10分</button>
        </div>
        <div className="who">
          <span className="tag">{ROLE_NAME[account.role]}</span>
          <b>{account.name}</b>
          {account.vehicleId && <span className="mono">（{account.vehicleId}）</span>}
          <button className="btn tiny ghost" onClick={() => setAccount(null)}>退出</button>
        </div>
      </header>
      <main>
        {account.role === 'dispatcher' && <DispatcherView snap={snap} account={account} />}
        {account.role === 'driver' && <DriverView snap={snap} account={account} />}
        {account.role === 'cs' && <CsView snap={snap} account={account} />}
        {account.role === 'master' && <MasterView snap={snap} account={account} />}
      </main>
    </div>
  );
}

export default Shell;
