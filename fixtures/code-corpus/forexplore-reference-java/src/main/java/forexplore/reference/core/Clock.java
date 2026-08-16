package forexplore.reference.core;

import java.time.Instant;

/**
 * 时钟抽象:把时间来源与业务解耦,便于注入可拨动时钟做测试。
 */
public interface Clock { Instant now(); }

