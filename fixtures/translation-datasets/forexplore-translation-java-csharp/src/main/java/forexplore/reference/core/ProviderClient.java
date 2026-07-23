package forexplore.reference.core;

public interface ProviderClient {
    String name();
    boolean supports(String pair);
    Quote fetch(String pair, long requestId);
}

