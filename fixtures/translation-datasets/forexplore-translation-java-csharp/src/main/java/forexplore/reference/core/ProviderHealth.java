package forexplore.reference.core;

import java.time.Duration;
import java.time.Instant;

public final class ProviderHealth {
    private final String provider;
    private int failures;
    private int successes;
    private Instant openUntil;
    private boolean probeInFlight;
    public ProviderHealth(String provider) { this.provider = provider; }
    public synchronized boolean canCall(Instant now) { return openUntil == null || !openUntil.isAfter(now); }
    public synchronized boolean reserveProbe(Instant now) {
        if (openUntil == null || openUntil.isAfter(now) || probeInFlight) return false;
        probeInFlight = true;
        return true;
    }
    public synchronized void success() { successes++; failures = 0; openUntil = null; probeInFlight = false; }
    public synchronized void failure(Instant now, Duration cooldown) { failures++; probeInFlight = false; openUntil = now.plus(cooldown); }
    public synchronized int failures() { return failures; }
    public synchronized int successes() { return successes; }
    public synchronized String provider() { return provider; }
    public synchronized String state(Instant now) { return canCall(now) ? (probeInFlight ? "HALF_OPEN" : "CLOSED") : "OPEN"; }
}

