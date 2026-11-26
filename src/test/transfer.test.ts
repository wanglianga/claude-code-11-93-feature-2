// 转运站窗口预约测试：锁量/排队两模式、不超售、估重≠实收、停收、改道、对比模拟
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDemo, setClock } from '../lib/actions';
import { loadSnapshot, type Snapshot } from '../lib/db';
import {
  ackInstruction, affectedBookings, driverArriveTransfer, driverWeighTransfer,
  issueInstruction, queuePosition, setCapacityMode, toggleWindowSuspend,
  updateWindow, windowLedger,
} from '../lib/transfer';
import { compareTransferModes, FIXED_SCENARIO, simulateLock, simulateQueue } from '../lib/transferSim';

async function snap(): Promise<Snapshot> {
  return loadSnapshot();
}

function ts1(s: Snapshot) {
  return s.transferStations.find((x) => x.id === 'TS1')!;
}
function w1(s: Snapshot) {
  return ts1(s).windows.find((w) => w.id === 'W1')!;
}
function booking(s: Snapshot, id: string) {
  return s.bookings.find((b) => b.id === id)!;
}

beforeEach(async () => {
  await resetDemo();
});

describe('种子现场（本题固定数据）', () => {
  it('W1 仅剩 10:00–10:30 窗口 4 吨；T1 锁 2.5（估），T2 估 2.0 被挡', async () => {
    const s = await snap();
    expect(ts1(s).mode).toBe('lock');
    const w = w1(s);
    expect(w.startMin).toBe(600);
    expect(w.endMin).toBe(630);
    expect(w.capacityTon).toBe(4.0);
    expect(booking(s, 'BK-T1').status).toBe('locked');
    expect(booking(s, 'BK-T2').status).toBe('blocked');
    const ledger = windowLedger(w, s.bookings);
    expect(ledger.lockedTon).toBeCloseTo(2.5);
    expect(ledger.receivedTon).toBe(0); // 估重不是实收
    expect(ledger.availableTon).toBeCloseTo(1.5);
  });
});

describe('锁量模式：过磅释放容量，被挡预约补锁', () => {
  it('T1 过磅实收 1.8 → 释放 0.7 → T2 补锁；T2 过磅 2.0 → 实收 3.8 不超售', async () => {
    let s = await snap();
    await setClock(606, '测试', '推进到 10:06');
    s = await snap();
    const r1 = await driverWeighTransfer(s, 'BK-T1', 1.8, '老王');
    expect(r1.ok).toBe(true);
    expect(r1.releasedTon).toBeCloseTo(0.7);
    expect(r1.promoted).toEqual(['BK-T2']);
    s = await snap();
    expect(booking(s, 'BK-T1').status).toBe('weighed');
    expect(booking(s, 'BK-T1').actualTon).toBeCloseTo(1.8);
    expect(booking(s, 'BK-T1').weighedAtMin).toBe(606); // 容量释放时刻 = 过磅时刻
    expect(booking(s, 'BK-T2').status).toBe('locked');
    let ledger = windowLedger(w1(s), s.bookings);
    expect(ledger.receivedTon).toBeCloseTo(1.8); // 实收只含实称 1.8，不是估重 2.5
    expect(ledger.lockedTon).toBeCloseTo(2.0);
    expect(ledger.availableTon).toBeCloseTo(0.2);

    await setClock(610, '测试', '推进到 10:10');
    s = await snap();
    const r2 = await driverWeighTransfer(s, 'BK-T2', 2.0, '小李');
    expect(r2.ok).toBe(true);
    s = await snap();
    ledger = windowLedger(w1(s), s.bookings);
    expect(ledger.receivedTon).toBeCloseTo(3.8); // 1.8 + 2.0，不超售（≤ 4.0）
    expect(ledger.receivedTon).toBeLessThanOrEqual(4.0);
    expect(ledger.lockedTon).toBe(0);
  });

  it('不超售：实称超过窗口可接收余量时拒绝登记', async () => {
    let s = await snap();
    await setClock(606, '测试', '推进到 10:06');
    s = await snap();
    await driverWeighTransfer(s, 'BK-T1', 1.8, '老王'); // 实收 1.8，T2 补锁 2.0
    s = await snap();
    // T2 若实称 2.5 吨：余量 = 4.0 − 实收1.8 − 他人锁量0 + 自己锁量2.0 = 2.2 < 2.5 → 拒
    const r = await driverWeighTransfer(s, 'BK-T2', 2.5, '小李');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('超售');
    s = await snap();
    expect(booking(s, 'BK-T2').status).toBe('locked'); // 状态未被改判
    expect(windowLedger(w1(s), s.bookings).receivedTon).toBeCloseTo(1.8); // 未登记
  });

  it('被挡预约不能过磅；窗口未到/已过不能过磅', async () => {
    let s = await snap();
    // 窗口 10:00 才开始（当前 09:20）
    const r2 = await driverWeighTransfer(s, 'BK-T1', 1.8, '老王');
    expect(r2.ok).toBe(false);
    expect(r2.reason).toContain('10:00 才开始');
    // 窗口内：BK-T2 处于 blocked，未锁到容量不能过磅
    await setClock(606, '测试', '推进到 10:06');
    s = await snap();
    const r1 = await driverWeighTransfer(s, 'BK-T2', 2.0, '小李');
    expect(r1.ok).toBe(false);
    expect(r1.reason).toContain('未锁到窗口容量');
    // 窗口结束后
    await setClock(631, '测试', '推进到 10:31');
    s = await snap();
    const r3 = await driverWeighTransfer(s, 'BK-T1', 1.8, '老王');
    expect(r3.ok).toBe(false);
    expect(r3.reason).toContain('结束');
  });

  it('已过磅的预约不能重复过磅（实收只计一次）', async () => {
    let s = await snap();
    await setClock(606, '测试', '推进到 10:06');
    s = await snap();
    const ok = await driverWeighTransfer(s, 'BK-T1', 1.8, '老王');
    expect(ok.ok).toBe(true);
    s = await snap();
    const again = await driverWeighTransfer(s, 'BK-T1', 1.8, '老王');
    expect(again.ok).toBe(false);
    expect(again.reason).toContain('不能重复过磅');
    s = await snap();
    expect(windowLedger(w1(s), s.bookings).receivedTon).toBeCloseTo(1.8); // 实收未被重复登记
  });
});

describe('排队模式：到场先后决定顺序，过磅才扣实际容量', () => {
  it('切换模式后预约转为登记状态；到场排队；非队首不能过磅；按序过磅后实收 3.8', async () => {
    let s = await snap();
    await setCapacityMode(s, 'TS1', 'queue', '赵站长');
    s = await snap();
    expect(ts1(s).mode).toBe('queue');
    expect(booking(s, 'BK-T1').status).toBe('booked');
    expect(booking(s, 'BK-T2').status).toBe('booked');
    // 锁量全部释放：台账只剩实收 0
    expect(windowLedger(w1(s), s.bookings).lockedTon).toBe(0);

    await setClock(602, '测试', '10:02');
    s = await snap();
    await driverArriveTransfer(s, 'BK-T1', '老王');
    s = await snap();
    expect(booking(s, 'BK-T1').status).toBe('queued');
    expect(queuePosition(w1(s), s.bookings, 'BK-T1')).toBe(1);
    await setClock(604, '测试', '10:04');
    s = await snap();
    await driverArriveTransfer(s, 'BK-T2', '小李');
    s = await snap();
    expect(queuePosition(w1(s), s.bookings, 'BK-T2')).toBe(2);

    // T2 不是队首 → 拒
    const r0 = await driverWeighTransfer(s, 'BK-T2', 2.0, '小李');
    expect(r0.ok).toBe(false);
    expect(r0.reason).toContain('排第 2 位');

    // 队首 T1 过磅 1.8 → 实收 1.8（此刻才知剩余 2.2）
    await setClock(606, '测试', '10:06');
    s = await snap();
    const r1 = await driverWeighTransfer(s, 'BK-T1', 1.8, '老王');
    expect(r1.ok).toBe(true);
    s = await snap();
    expect(windowLedger(w1(s), s.bookings).receivedTon).toBeCloseTo(1.8);
    expect(queuePosition(w1(s), s.bookings, 'BK-T2')).toBe(1); // T2 成为队首

    // T2 过磅 2.0 → 实收 3.8 ≤ 4.0
    await setClock(610, '测试', '10:10');
    s = await snap();
    const r2 = await driverWeighTransfer(s, 'BK-T2', 2.0, '小李');
    expect(r2.ok).toBe(true);
    s = await snap();
    expect(windowLedger(w1(s), s.bookings).receivedTon).toBeCloseTo(3.8);
  });

  it('不超售：剩余容量不足时队首也被拒（只能等下一窗口或改道）', async () => {
    let s = await snap();
    await setCapacityMode(s, 'TS1', 'queue', '赵站长');
    await setClock(602, '测试', '10:02');
    s = await snap();
    await driverArriveTransfer(s, 'BK-T1', '老王');
    s = await snap();
    await driverWeighTransfer(s, 'BK-T1', 1.8, '老王');
    await setClock(604, '测试', '10:04');
    s = await snap();
    await driverArriveTransfer(s, 'BK-T2', '小李');
    s = await snap();
    // 剩余 2.2，T2 若实称 2.5 → 拒
    const r = await driverWeighTransfer(s, 'BK-T2', 2.5, '小李');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('超售');
    s = await snap();
    expect(windowLedger(w1(s), s.bookings).receivedTon).toBeCloseTo(1.8);
  });
});

describe('站长调整窗口与临时停收', () => {
  it('容量不得调到低于已锁+已实收（否则等同超售）；扩容后被挡预约补锁', async () => {
    let s = await snap();
    // 已锁 2.5 + 实收 0 = 2.5 → 调到 2.0 拒绝
    const bad = await updateWindow(s, 'TS1', 'W1', { startMin: 600, endMin: 630, capacityTon: 2.0 }, '赵站长');
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain('不得超售');
    // 扩容到 5.0 → 可锁余量 2.5 ≥ T2 估 2.0 → T2 补锁
    const ok = await updateWindow(s, 'TS1', 'W1', { startMin: 600, endMin: 630, capacityTon: 5.0 }, '赵站长');
    expect(ok.ok).toBe(true);
    s = await snap();
    expect(booking(s, 'BK-T2').status).toBe('locked');
    expect(windowLedger(w1(s), s.bookings).availableTon).toBeCloseTo(0.5);
  });

  it('临时停收：预约成为真实阻塞，过磅被拒；恢复后可用', async () => {
    let s = await snap();
    await toggleWindowSuspend(s, 'TS1', 'W1', true, '设备检修', '赵站长');
    s = await snap();
    expect(w1(s).suspended).toBe(true);
    // 受阻列表包含 T1、T2，并牵连其未完成线路站点
    const affected = affectedBookings(s);
    expect(affected.map((a) => a.booking.vehicleId).sort()).toEqual(['T1', 'T2']);
    expect(affected.find((a) => a.booking.vehicleId === 'T1')!.affectedStations.length).toBeGreaterThan(0);
    // 停收期间过磅被拒
    await setClock(606, '测试', '10:06');
    s = await snap();
    const r = await driverWeighTransfer(s, 'BK-T1', 1.8, '老王');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('临时停收');
    // 恢复后可过磅
    await toggleWindowSuspend(s, 'TS1', 'W1', false, '', '赵站长');
    s = await snap();
    const r2 = await driverWeighTransfer(s, 'BK-T1', 1.8, '老王');
    expect(r2.ok).toBe(true);
  });
});

describe('调度安排：等待 / 改道', () => {
  it('改道确认后原预约 diverted，目标站生成新预约并锁窗', async () => {
    let s = await snap();
    await issueInstruction(s, {
      vehicleId: 'T2', kind: 'divert', stationId: 'TS1',
      targetStationId: 'TS2', windowId: 'W2',
      message: '城西 W1 锁量不足，请改道城北转运站 W2 窗口（09:30–12:00）',
    }, '张调度');
    s = await snap();
    const instr = s.instructions[0];
    expect(instr.kind).toBe('divert');
    expect(instr.acked).toBe(false);
    await ackInstruction(s, instr.id, '小李');
    s = await snap();
    expect(s.instructions[0].acked).toBe(true);
    expect(booking(s, 'BK-T2').status).toBe('diverted');
    const fresh = booking(s, 'BK-T2-TS2');
    expect(fresh.status).toBe('locked'); // TS2 容量 8 吨，余量充足
    expect(fresh.estTon).toBeCloseTo(2.0);
    // 原窗口锁量释放：W1 只剩 T1 的 2.5
    expect(windowLedger(w1(s), s.bookings).lockedTon).toBeCloseTo(2.5);
  });

  it('等待安排：司机确认后预约保持被挡，等容量释放', async () => {
    let s = await snap();
    await issueInstruction(s, {
      vehicleId: 'T2', kind: 'wait', stationId: 'TS1',
      message: '请在城西转运站等待：T1 过磅后释放容量即可补锁',
    }, '张调度');
    s = await snap();
    await ackInstruction(s, s.instructions[0].id, '小李');
    s = await snap();
    expect(s.instructions[0].acked).toBe(true);
    expect(booking(s, 'BK-T2').status).toBe('blocked'); // 未改道，仍等释放
  });
});

describe('两模式对比模拟（本题固定数据）', () => {
  it('锁量：T2 先被挡，10:06 T1 过磅释放 0.7 后补锁；实收 3.8 不超售', () => {
    const r = simulateLock(FIXED_SCENARIO);
    expect(r.accepted).toEqual(['T1', 'T2']);
    expect(r.serviceOrder).toEqual(['T1', 'T2']);
    expect(r.releaseEvents).toHaveLength(1);
    expect(r.releaseEvents[0].min).toBe(606); // 容量释放时刻 = T1 过磅时刻
    expect(r.releaseEvents[0].ton).toBeCloseTo(0.7);
    expect(r.receivedTon).toBeCloseTo(3.8);
    expect(r.oversold).toBe(false);
    // 关键事件序列
    expect(r.events[0].text).toContain('T1 按估重 2.5 吨锁窗成功');
    expect(r.events[1].text).toContain('T2 估重 2.0 吨 > 剩余可锁 1.5 吨');
  });

  it('排队：按到场顺序都接纳；无容量释放概念；实收 3.8 不超售', () => {
    const r = simulateQueue(FIXED_SCENARIO);
    expect(r.accepted).toEqual(['T1', 'T2']);
    expect(r.serviceOrder).toEqual(['T1', 'T2']);
    expect(r.releaseEvents).toHaveLength(0);
    expect(r.receivedTon).toBeCloseTo(3.8);
    expect(r.oversold).toBe(false);
  });

  it('对比表覆盖可接车辆、等待顺序、容量释放时刻；两模式估重均不计入实收', () => {
    const c = compareTransferModes();
    const dims = c.rows.map((r) => r.dimension);
    expect(dims).toContain('可接车辆');
    expect(dims).toContain('等待顺序');
    expect(dims).toContain('容量释放时刻');
    expect(c.lock.receivedTon).toBeCloseTo(3.8); // 实收 = 1.8 + 2.0，不是估重 2.5 + 2.0
    expect(c.queue.receivedTon).toBeCloseTo(3.8);
    expect(c.lock.oversold).toBe(false);
    expect(c.queue.oversold).toBe(false);
  });

  it('反事实：加一辆 T3（估/实 0.5，10:08 到场）后，两模式接纳构成不同且都不超售', () => {
    const sc = {
      ...FIXED_SCENARIO,
      vehicles: [
        ...FIXED_SCENARIO.vehicles,
        { id: 'T3', estTon: 0.5, actualTon: 0.5, arriveMin: 608 },
      ],
    };
    const lock = simulateLock(sc);
    // 锁量：T3 先锁进（剩 1.5 ≥ 0.5）；T1 过磅释放后余 1.7 < 2.0，T2 始终被挡
    expect(lock.accepted).toEqual(['T1', 'T3']);
    expect(lock.turnedAway).toEqual(['T2']);
    expect(lock.receivedTon).toBeCloseTo(2.3);
    expect(lock.oversold).toBe(false);
    const queue = simulateQueue(sc);
    // 排队：T1、T2 按到场序先过磅（实收 3.8），T3 轮到时剩 0.2 < 0.5 被拒
    expect(queue.accepted).toEqual(['T1', 'T2']);
    expect(queue.turnedAway).toEqual(['T3']);
    expect(queue.receivedTon).toBeCloseTo(3.8);
    expect(queue.oversold).toBe(false);
  });
});
