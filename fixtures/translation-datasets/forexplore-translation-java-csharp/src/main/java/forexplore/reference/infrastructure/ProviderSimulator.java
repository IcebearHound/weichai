package forexplore.reference.infrastructure;

import forexplore.reference.core.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.Set;

public final class ProviderSimulator implements ProviderClient {
    private final String name;
    private final int basis;
    private final int failuresBeforeSuccess;
    private final Clock clock;
    private int calls;
    public ProviderSimulator(String name, int basis, int failuresBeforeSuccess, Clock clock) { this.name = name; this.basis = basis; this.failuresBeforeSuccess = failuresBeforeSuccess; this.clock = clock; }
    public String name() { return name; }
    public boolean supports(String pair) { return Set.of("EURUSD", "GBPUSD", "USDJPY", "AUDUSD").contains(pair); }
    public synchronized Quote fetch(String pair, long requestId) {
        calls++;
        if (calls <= failuresBeforeSuccess) throw new IllegalStateException(name + " temporary failure");
        int offset = Math.floorMod(basis + pair.hashCode() + (int) requestId, 41);
        Money bid = new Money(pair.substring(0, 3), BigDecimal.valueOf(1000 + offset, 2));
        Money ask = new Money(pair.substring(0, 3), bid.amount().add(BigDecimal.valueOf(3, 2)));
        return new Quote(name, pair, bid, ask, clock.now(), 5 + offset);
    }
}

