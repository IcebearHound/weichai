package forexplore.reference.infrastructure;

import forexplore.reference.core.Clock;
import java.time.Duration;
import java.time.Instant;

public final class MutableClock implements Clock {
    private Instant current;
    public MutableClock(Instant initial) { current = initial; }
    public synchronized Instant now() { return current; }
    public synchronized void advance(Duration amount) { current = current.plus(amount); }
    public synchronized void set(Instant value) { current = value; }
}

