package forexplore.reference.core;

import java.time.Instant;

/**
 * 重试任务:带幂等键、当前尝试次数、到期时间与失败原因的调度单元。
 */
public record RetryTask(String key, int attempt, Instant dueAt, String reason) {
    /** 生成下一次重试(尝试数 +1,更新到期时间与原因)。 */
    public RetryTask next(Instant nextDue, String nextReason) { return new RetryTask(key, attempt + 1, nextDue, nextReason); }
    /** 是否已到期(当前时刻不晚于 dueAt 视为未到期)。 */
    public boolean due(Instant now) { return !dueAt.isAfter(now); }
}

