package forexplore.reference.infrastructure;

import forexplore.reference.core.Clock;
import java.time.Duration;
import java.time.Instant;

/**
 * 可拨动时钟:测试/演示用,可 advance/set 控制当前时刻。
 */
public final class MutableClock implements Clock {
    private Instant current;
    public MutableClock(Instant initial) { current = initial; }
    public synchronized Instant now() { return current; }
    public synchronized void advance(Duration amount) { current = current.plus(amount); }
    public synchronized void set(Instant value) { current = value; }
}

