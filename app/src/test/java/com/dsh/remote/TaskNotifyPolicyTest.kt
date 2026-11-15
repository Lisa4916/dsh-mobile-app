package com.dsh.remote

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * [TaskNotifyPolicy] 的行为约束。
 *
 * 这类「什么时候弹通知」的规则最容易在真机上被骂，所以每条都写成可测的：
 * 宁可漏发，不可错发 —— 错发一次用户就会去关通知权限，之后真通知也看不到了。
 */
class TaskNotifyPolicyTest {

    @Test
    fun firstSampleNeverNotifies() {
        // 刚连上页面时第一次采样，没有「上一次」，不能凭空判定「刚刚完成」。
        val d = TaskNotifyPolicy.decide(
            previous = null,
            current = RunStateProbe.Snapshot(running = false, title = "改个 bug"),
            appVisible = false,
            lastNotifiedAt = 0L,
            now = 1_000L,
        )
        assertEquals(TaskNotifyPolicy.Action.NONE, d)
    }

    @Test
    fun runningToIdleInBackgroundNotifies() {
        val d = TaskNotifyPolicy.decide(
            previous = RunStateProbe.Snapshot(running = true, title = "改个 bug"),
            current = RunStateProbe.Snapshot(running = false, title = "改个 bug"),
            appVisible = false,
            lastNotifiedAt = 0L,
            now = 60_000L,
        )
        assertEquals(TaskNotifyPolicy.Action.NOTIFY, d)
    }

    @Test
    fun runningToIdleWhileVisibleStaysQuiet() {
        // 用户正盯着屏幕，看到回答了，不需要再弹一条。
        val d = TaskNotifyPolicy.decide(
            previous = RunStateProbe.Snapshot(running = true, title = "改个 bug"),
            current = RunStateProbe.Snapshot(running = false, title = "改个 bug"),
            appVisible = true,
            lastNotifiedAt = 0L,
            now = 60_000L,
        )
        assertEquals(TaskNotifyPolicy.Action.NONE, d)
    }

    @Test
    fun idleToRunningDoesNothing() {
        val d = TaskNotifyPolicy.decide(
            previous = RunStateProbe.Snapshot(running = false, title = "t"),
            current = RunStateProbe.Snapshot(running = true, title = "t"),
            appVisible = false,
            lastNotifiedAt = 0L,
            now = 60_000L,
        )
        assertEquals(TaskNotifyPolicy.Action.NONE, d)
    }

    @Test
    fun idleToIdleRepeatedSamplesStayQuiet() {
        // 轮询每 2 秒一次，空闲时会有成千上万次 false→false，必须一条都不发。
        var last = 0L
        for (t in 0 until 100) {
            val d = TaskNotifyPolicy.decide(
                previous = RunStateProbe.Snapshot(running = false, title = "t"),
                current = RunStateProbe.Snapshot(running = false, title = "t"),
                appVisible = false,
                lastNotifiedAt = last,
                now = t * 2_000L,
            )
            assertEquals(TaskNotifyPolicy.Action.NONE, d)
            if (d == TaskNotifyPolicy.Action.NOTIFY) last = t * 2_000L
        }
    }

    @Test
    fun unknownSampleIsTreatedAsNoChange() {
        // parse 失败返回 null。拿不准时既不能当「完成」，也不能清掉上一次的 running 状态。
        val d = TaskNotifyPolicy.decide(
            previous = RunStateProbe.Snapshot(running = true, title = "t"),
            current = null,
            appVisible = false,
            lastNotifiedAt = 0L,
            now = 60_000L,
        )
        assertEquals(TaskNotifyPolicy.Action.NONE, d)
    }

    @Test
    fun doesNotNotifyWhenPreviousWasUnknownButIdle() {
        val d = TaskNotifyPolicy.decide(
            previous = RunStateProbe.Snapshot(running = false, title = "t"),
            current = RunStateProbe.Snapshot(running = false, title = "t"),
            appVisible = false,
            lastNotifiedAt = 0L,
            now = 60_000L,
        )
        assertEquals(TaskNotifyPolicy.Action.NONE, d)
    }

    @Test
    fun suppressesRepeatsWithinCooldown() {
        // 同一次回答可能因为页面重渲染出现 true→false→true→false 的抖动（比如工具调用间隙）。
        // 冷却窗口内只发第一条。
        val previous = RunStateProbe.Snapshot(running = true, title = "t")
        val current = RunStateProbe.Snapshot(running = false, title = "t")
        val first = TaskNotifyPolicy.decide(previous, current, false, 0L, 10_000L)
        assertEquals(TaskNotifyPolicy.Action.NOTIFY, first)
        val second = TaskNotifyPolicy.decide(previous, current, false, 10_000L, 11_000L)
        assertEquals(TaskNotifyPolicy.Action.NONE, second)
    }

    @Test
    fun allowsNotifyAgainAfterCooldown() {
        val previous = RunStateProbe.Snapshot(running = true, title = "t")
        val current = RunStateProbe.Snapshot(running = false, title = "t")
        val d = TaskNotifyPolicy.decide(
            previous, current, false,
            lastNotifiedAt = 10_000L,
            now = 10_000L + TaskNotifyPolicy.COOLDOWN_MS,
        )
        assertEquals(TaskNotifyPolicy.Action.NOTIFY, d)
    }

    @Test
    fun cooldownIsShortEnoughForRealWork() {
        // 实测一次中等长度的回答 20~60 秒。冷却必须明显小于这个数量级，
        // 否则连续两个任务只有第一个会通知。
        assertEquals(true, TaskNotifyPolicy.COOLDOWN_MS <= 5_000L)
    }
}
