package forexplore.reference.core;

/**
 * 报价提供方客户端抽象:提供方名称、支持检测与单次取价能力。
 * 实现可以是真实网关或测试替身。
 */
public interface ProviderClient {
    String name();
    boolean supports(String pair);
    Quote fetch(String pair, long requestId);
}

