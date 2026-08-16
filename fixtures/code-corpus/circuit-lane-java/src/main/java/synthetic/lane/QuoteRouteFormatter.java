package synthetic.lane;

import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * 报价路由文本格式化器:把「币种对 + 区域 + 跳点列表 + 修订号」编码成 URL 形式的规范路由,
 * 并支持解析回跳点列表。解析时要求输入与规范格式完全一致(反序列化即校验)。
 */
public final class QuoteRouteFormatter {
    private final String prefix;
    private final int maximumHops;

    public QuoteRouteFormatter(String prefix, int maximumHops) {
        this.prefix = Objects.requireNonNull(prefix, "route prefix").strip();
        if (this.prefix.isEmpty() || this.prefix.length() > 40) {
            throw new IllegalArgumentException("route prefix is invalid");
        }
        if (this.prefix.indexOf('/') >= 0 || this.prefix.indexOf('?') >= 0 || this.prefix.indexOf('#') >= 0) {
            throw new IllegalArgumentException("route prefix contains reserved syntax");
        }
        if (maximumHops < 1 || maximumHops > 100) {
            throw new IllegalArgumentException("route hop capacity is outside supported range");
        }
        this.maximumHops = maximumHops;
    }

    /**
     * 生成规范路由:路径段为前缀 + 币种对,查询段带 region/revision/hops。
     * 跳点逐个 URL 编码后以逗号连接,跳点不允许重复。
     */
    public String format(
            MarketModels.CurrencyPair pair,
            String region,
            List<String> hops,
            long revision
    ) {
        Objects.requireNonNull(pair, "route pair");
        Objects.requireNonNull(region, "route region");
        Objects.requireNonNull(hops, "route hops");
        String normalizedRegion = region.strip().toLowerCase();
        if (normalizedRegion.isEmpty() || normalizedRegion.length() > 40) {
            throw new IllegalArgumentException("route region is invalid");
        }
        if (revision < 0) {
            throw new IllegalArgumentException("route revision cannot be negative");
        }
        if (hops.isEmpty() || hops.size() > maximumHops) {
            throw new IllegalArgumentException("route hop count is outside supported range");
        }
        Set<String> unique = new HashSet<>();
        List<String> encodedHops = new ArrayList<>(hops.size());
        for (int index = 0; index < hops.size(); index++) {
            String hop = Objects.requireNonNull(hops.get(index), "route hop").strip();
            if (hop.isEmpty() || hop.length() > 64) {
                throw new IllegalArgumentException("route hop is invalid at " + index);
            }
            if (!unique.add(hop)) {
                throw new IllegalArgumentException("route hop repeats: " + hop);
            }
            encodedHops.add(URLEncoder.encode(hop, StandardCharsets.UTF_8));
        }
        String pairSegment = pair.base() + "-" + pair.counter();
        String route = prefix
                + "/"
                + pairSegment
                + "?region="
                + URLEncoder.encode(normalizedRegion, StandardCharsets.UTF_8)
                + "&revision="
                + revision
                + "&hops="
                + String.join(",", encodedHops);
        if (route.length() > 16_384) {
            throw new IllegalStateException("formatted quote route exceeds sixteen kilobytes");
        }
        return route;
    }

    /**
     * 解析路由文本,还原跳点列表。解析结果必须与 format 生成的规范串完全一致,
     * 任何顺序/编码偏差都会被视为非法输入,防止缓存/分发中出现同义不同串的混乱。
     */
    public List<String> parse(String route) {
        Objects.requireNonNull(route, "quote route");
        if (route.length() > 16_384) {
            throw new IllegalArgumentException("quote route exceeds sixteen kilobytes");
        }
        int queryStart = route.indexOf('?');
        if (queryStart < 1 || route.indexOf('?', queryStart + 1) >= 0) {
            throw new IllegalArgumentException("quote route query separator is invalid");
        }
        String[] path = route.substring(0, queryStart).split("/", -1);
        if (path.length != 2 || !path[0].equals(prefix)) {
            throw new IllegalArgumentException("quote route prefix is invalid");
        }
        String[] pairCodes = path[1].split("-", -1);
        if (pairCodes.length != 2) {
            throw new IllegalArgumentException("quote route pair segment is invalid");
        }
        MarketModels.CurrencyPair pair = new MarketModels.CurrencyPair(pairCodes[0], pairCodes[1]);
        Map<String, String> query = new LinkedHashMap<>();
        for (String field : route.substring(queryStart + 1).split("&", -1)) {
            int separator = field.indexOf('=');
            if (separator < 1) {
                throw new IllegalArgumentException("quote route query field is invalid");
            }
            String name = field.substring(0, separator);
            String value = field.substring(separator + 1);
            if (query.putIfAbsent(name, value) != null) {
                throw new IllegalArgumentException("quote route query field repeats: " + name);
            }
        }
        if (!query.keySet().equals(Set.of("region", "revision", "hops"))) {
            throw new IllegalArgumentException("quote route query fields are incomplete or unknown");
        }
        String region = URLDecoder.decode(query.get("region"), StandardCharsets.UTF_8);
        if (region.isEmpty() || region.length() > 40) {
            throw new IllegalArgumentException("quote route region is invalid");
        }
        long revision;
        try {
            revision = Long.parseLong(query.get("revision"));
        } catch (NumberFormatException failure) {
            throw new IllegalArgumentException("quote route revision is invalid", failure);
        }
        if (revision < 0) {
            throw new IllegalArgumentException("quote route revision cannot be negative");
        }
        String hopText = query.get("hops");
        if (hopText.isEmpty()) {
            throw new IllegalArgumentException("quote route has no hops");
        }
        List<String> hops = new ArrayList<>();
        Set<String> unique = new HashSet<>();
        for (String encoded : hopText.split(",", -1)) {
            String hop = URLDecoder.decode(encoded, StandardCharsets.UTF_8);
            if (hop.isEmpty() || !unique.add(hop)) {
                throw new IllegalArgumentException("quote route hop is empty or repeated");
            }
            hops.add(hop);
        }
        if (hops.size() > maximumHops) {
            throw new IllegalArgumentException("quote route exceeds hop capacity");
        }
        // 用规范格式重新生成并与输入比对,保证解析结果的唯一规范化表示
        String canonical = format(pair, region, hops, revision);
        if (!canonical.equals(route)) {
            throw new IllegalArgumentException("quote route is not canonical");
        }
        return List.copyOf(hops);
    }
}
