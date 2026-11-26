// 视图渲染冒烟测试：四个角色视图在种子现场下都能完整渲染（不抛异常、关键内容在）
import 'fake-indexeddb/auto';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDemo, setClock } from '../lib/actions';
import { loadSnapshot, type Snapshot } from '../lib/db';
import { ACCOUNTS } from '../lib/seed';
import { driverWeighTransfer } from '../lib/transfer';
import { DispatcherView } from '../components/DispatcherView';
import { DriverView } from '../components/DriverView';
import { CsView } from '../components/CsView';
import { MasterView } from '../components/MasterView';

const ACC = Object.fromEntries(ACCOUNTS.map((a) => [a.username, a]));

let snap: Snapshot;

beforeEach(async () => {
  await resetDemo();
  snap = await loadSnapshot();
});

describe('角色视图渲染（种子现场）', () => {
  it('调度员视图：转运站队列、被挡的 T2、两模式对比', () => {
    const html = renderToString(<DispatcherView snap={snap} account={ACC.dispatcher} />);
    expect(html).toContain('转运站队列与受影响站点');
    expect(html).toContain('城西转运站');
    expect(html).toContain('BK-T2');
    expect(html).toContain('被挡');
    expect(html).toContain('锁量 vs 到场排队');
    expect(html).toContain('容量释放时刻');
    expect(html).toContain('可接车辆');
  });

  it('站长视图：窗口管理、模式切换、台账', () => {
    const html = renderToString(<MasterView snap={snap} account={ACC.master} />);
    expect(html).toContain('窗口管理');
    expect(html).toContain('保存窗口');
    expect(html).toContain('临时停收');
    expect(html).toContain('容量模式切换');
    expect(html).toContain('已卸实收');
  });

  it('司机视图（T2）：自己的被挡预约与等释放提示', () => {
    const html = renderToString(<DriverView snap={snap} account={ACC.driver2} />);
    expect(html).toContain('转运站预约');
    expect(html).toContain('BK-T2');
    expect(html).toContain('被挡');
    expect(html).toContain('等容量释放或调度安排');
  });

  it('客服视图：通知核查不受影响', () => {
    const html = renderToString(<CsView snap={snap} account={ACC.service} />);
    expect(html).toContain('预约通知有效性');
  });
});

describe('流程后视图渲染', () => {
  it('T1 过磅后：调度员看到 T2 补锁、实收 1.8；司机 T1 看到过磅完成', async () => {
    await setClock(606, '测试', '10:06');
    let s = await loadSnapshot();
    const r = await driverWeighTransfer(s, 'BK-T1', 1.8, '老王');
    expect(r.ok).toBe(true);
    s = await loadSnapshot();
    const dispHtml = renderToString(<DispatcherView snap={s} account={ACC.dispatcher} />);
    expect(dispHtml).toContain('已锁窗'); // BK-T2 补锁成功
    expect(dispHtml).toContain('1.8t');  // 实收入账
    const drvHtml = renderToString(<DriverView snap={s} account={ACC.driver1} />);
    expect(drvHtml).toContain('已过磅');
  });
});
