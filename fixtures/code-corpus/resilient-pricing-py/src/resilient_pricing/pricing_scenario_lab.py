"""定价场景实验室:端到端执行一个"报价→选价→路由→交易→结算"场景。

run 按以下流水线处理:1) 校验报价(供应商白名单、币种、价格、时效),
选择每对货币的最优报价并计算价差;2) 对交易行做 BFS 路由规划(带缓存)
与一系列校验(重复 ID、账户序号单调、数量、限额);3) 按账户+序号排序后
逐笔调用收据写入器结算,并用哈希链生成审计帧;4) 汇总各类统计。
"""

from __future__ import annotations

import hashlib
import math
import statistics
import time
from collections import Counter, defaultdict, deque
from collections.abc import Callable, Mapping, Sequence
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP


class PricingScenarioLab:
    """定价场景执行器。

    run 一次性执行完整场景并返回结构化结果(只读语义的字典)。
    """

    def run(
        self,
        scenario_id: str,
        quote_rows: Sequence[Mapping[str, object]],
        trade_rows: Sequence[Mapping[str, object]],
        provider_order: Sequence[str],
        route_edges: Mapping[str, Sequence[str]],
        account_limits: Mapping[str, int],
        receipt_writer: Callable[[Mapping[str, object]], str],
        now: float | None = None,
    ) -> dict[str, object]:
        """执行一个定价场景,返回完整结果字典。

        入参:报价行、交易行、供应商优先级、路由边、账户限额、收据写入器
        (receipt_writer 抛异常视为结算失败)。内部按报价校验→选价→路由→
        交易校验→排序结算→审计链 的顺序推进,拒绝明细与各类统计
        均包含在返回值中。
        """
        normalized_scenario = scenario_id.strip()
        if not normalized_scenario or len(normalized_scenario) > 128:
            raise ValueError("scenario_id must contain from 1 to 128 characters")
        observed_at = time.time() if now is None else now
        if not math.isfinite(observed_at):
            raise ValueError("now must be finite")

        providers: list[str] = []
        seen_providers: set[str] = set()
        for index, raw_provider in enumerate(provider_order):
            provider = raw_provider.strip().lower()
            if not provider or len(provider) > 64:
                raise ValueError(f"provider {index} has an invalid name")
            if provider in seen_providers:
                raise ValueError(f"duplicate provider: {provider}")
            seen_providers.add(provider)
            providers.append(provider)
        # 供应商优先级排名:下标越小优先级越高
        provider_rank = {provider: index for index, provider in enumerate(providers)}

        adjacency: dict[str, tuple[str, ...]] = {}
        all_route_nodes: set[str] = set()
        for raw_source, raw_destinations in route_edges.items():
            source = raw_source.strip().upper()
            if not source or len(source) > 32:
                raise ValueError(f"invalid route source: {raw_source}")
            destinations: list[str] = []
            seen_destinations: set[str] = set()
            for raw_destination in raw_destinations:
                destination = raw_destination.strip().upper()
                if not destination or len(destination) > 32:
                    raise ValueError(f"invalid route destination from {source}")
                if destination == source:
                    raise ValueError(f"self route at {source}")
                if destination not in seen_destinations:
                    seen_destinations.add(destination)
                    destinations.append(destination)
                all_route_nodes.add(destination)
            destinations.sort()
            adjacency[source] = tuple(destinations)
            all_route_nodes.add(source)

        limits: dict[str, int] = {}
        for raw_account, raw_limit in account_limits.items():
            account = raw_account.strip()
            if not account or len(account) > 128:
                raise ValueError(f"invalid account limit key: {raw_account}")
            if not isinstance(raw_limit, int) or isinstance(raw_limit, bool) or raw_limit < 0:
                raise ValueError(f"invalid account limit for {account}")
            limits[account] = raw_limit

        valid_quotes: list[dict[str, object]] = []
        rejected_quotes: list[dict[str, object]] = []
        quote_versions: dict[tuple[str, str], list[dict[str, object]]] = defaultdict(list)
        for index, raw_quote in enumerate(quote_rows):
            provider = str(raw_quote.get("provider", "")).strip().lower()
            base = str(raw_quote.get("base", "")).strip().upper()
            counter = str(raw_quote.get("counter", "")).strip().upper()
            reasons: list[str] = []
            if provider not in provider_rank:
                reasons.append("provider")
            if len(base) != 3 or not base.isalpha() or not base.isascii():
                reasons.append("base")
            if len(counter) != 3 or not counter.isalpha() or not counter.isascii():
                reasons.append("counter")
            if base == counter and base:
                reasons.append("same_currency")

            try:
                raw_price = raw_quote.get("price")
                price = Decimal(str(raw_price))
                if not price.is_finite() or price <= 0:
                    reasons.append("price")
            except (InvalidOperation, ValueError):
                price = Decimal(0)
                reasons.append("price")
            try:
                timestamp = float(raw_quote.get("timestamp", math.nan))
                if not math.isfinite(timestamp) or timestamp < 0:
                    reasons.append("timestamp")
            except (TypeError, ValueError):
                timestamp = math.nan
                reasons.append("timestamp")

            age_seconds = observed_at - timestamp if math.isfinite(timestamp) else math.inf
            # 时效窗口:早于 1 秒视为未来时间戳,晚于 5 秒视为过期
            if age_seconds < -1.0:
                reasons.append("future")
            if age_seconds > 5.0:
                reasons.append("stale")
            if reasons:
                rejected_quotes.append(
                    {
                        "index": index,
                        "provider": provider,
                        "pair": f"{base}/{counter}",
                        "reasons": tuple(dict.fromkeys(reasons)),
                    }
                )
                continue

            accepted = {
                "index": index,
                "provider": provider,
                "base": base,
                "counter": counter,
                "pair": f"{base}/{counter}",
                "price": price,
                "timestamp": timestamp,
                "age_seconds": max(0.0, age_seconds),
                "provider_rank": provider_rank[provider],
            }
            valid_quotes.append(accepted)
            quote_versions[(base, counter)].append(accepted)

        selected_quotes: dict[str, dict[str, object]] = {}
        spread_by_pair: dict[str, Decimal] = {}
        for pair_key, versions in sorted(quote_versions.items()):
            # 同一货币对择优:供应商优先级 → 时间戳新 → 输入顺序
            versions.sort(
                key=lambda row: (
                    int(row["provider_rank"]),
                    -float(row["timestamp"]),
                    int(row["index"]),
                )
            )
            selected = versions[0]
            pair_name = f"{pair_key[0]}/{pair_key[1]}"
            selected_quotes[pair_name] = selected
            prices = [Decimal(row["price"]) for row in versions]
            # 价差 = 同对最高价 - 最低价,衡量该对的报价分歧
            spread_by_pair[pair_name] = max(prices) - min(prices)

        route_cache: dict[tuple[str, str], tuple[str, ...]] = {}
        unresolved_routes: list[tuple[str, str]] = []
        def_route_requests: set[tuple[str, str]] = set()
        for raw_trade in trade_rows:
            source = str(raw_trade.get("source", "")).strip().upper()
            destination = str(raw_trade.get("destination", "")).strip().upper()
            if source and destination:
                def_route_requests.add((source, destination))
        for source, destination in sorted(def_route_requests):
            if source == destination:
                route_cache[(source, destination)] = (source,)
                continue
            # BFS 求最短路径;命中目的地后清空 frontier 提前结束
            frontier: deque[tuple[str, tuple[str, ...]]] = deque([(source, (source,))])
            visited = {source}
            found: tuple[str, ...] | None = None
            while frontier:
                node, path = frontier.popleft()
                for neighbor in adjacency.get(node, ()):
                    if neighbor == destination:
                        found = (*path, neighbor)
                        frontier.clear()
                        break
                    if neighbor in visited:
                        continue
                    visited.add(neighbor)
                    frontier.append((neighbor, (*path, neighbor)))
            if found is None:
                unresolved_routes.append((source, destination))
            else:
                route_cache[(source, destination)] = found

        prepared_trades: list[dict[str, object]] = []
        rejected_trades: list[dict[str, object]] = []
        seen_trade_ids: set[str] = set()
        sequence_by_account: dict[str, int] = {}
        exposure_by_account: dict[str, int] = defaultdict(int)
        exposure_by_currency: dict[str, int] = defaultdict(int)
        for index, raw_trade in enumerate(trade_rows):
            trade_id = str(raw_trade.get("trade_id", "")).strip()
            account = str(raw_trade.get("account", "")).strip()
            base = str(raw_trade.get("base", "")).strip().upper()
            counter = str(raw_trade.get("counter", "")).strip().upper()
            source = str(raw_trade.get("source", "")).strip().upper()
            destination = str(raw_trade.get("destination", "")).strip().upper()
            reasons: list[str] = []
            if not trade_id or len(trade_id) > 128:
                reasons.append("trade_id")
            elif trade_id in seen_trade_ids:
                reasons.append("duplicate")
            if not account or len(account) > 128:
                reasons.append("account")
            try:
                sequence = int(raw_trade.get("sequence", -1))
                if sequence < 0:
                    reasons.append("sequence")
            except (TypeError, ValueError):
                sequence = -1
                reasons.append("sequence")
            previous_sequence = sequence_by_account.get(account)
            if previous_sequence is not None and sequence <= previous_sequence:
                # 同一账户序号必须严格递增,否则判定乱序
                reasons.append("sequence_order")
            try:
                quantity_minor = int(raw_trade.get("quantity_minor", 0))
                if quantity_minor == 0:
                    reasons.append("quantity")
            except (TypeError, ValueError):
                quantity_minor = 0
                reasons.append("quantity")
            pair = f"{base}/{counter}"
            quote = selected_quotes.get(pair)
            if quote is None:
                reasons.append("quote")
            route = route_cache.get((source, destination))
            if route is None:
                reasons.append("route")

            limit = limits.get(account)
            proposed_exposure = exposure_by_account[account] + abs(quantity_minor)
            if limit is not None and proposed_exposure > limit:
                # 账户累计敞口(绝对值累计)超限即拒绝
                reasons.append("limit")
            if reasons:
                rejected_trades.append(
                    {
                        "index": index,
                        "trade_id": trade_id,
                        "account": account,
                        "reasons": tuple(dict.fromkeys(reasons)),
                    }
                )
                continue

            seen_trade_ids.add(trade_id)
            sequence_by_account[account] = sequence
            exposure_by_account[account] = proposed_exposure
            # 基准币 +、计价币 -,维护各币种净敞口
            exposure_by_currency[base] += quantity_minor
            exposure_by_currency[counter] -= quantity_minor
            price = Decimal(quote["price"])
            # 金额 × 价格,四舍五入到最小单位(整数)
            gross_counter_minor = (
                Decimal(abs(quantity_minor)) * price
            ).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
            prepared_trades.append(
                {
                    "index": index,
                    "trade_id": trade_id,
                    "account": account,
                    "sequence": sequence,
                    "pair": pair,
                    "quantity_minor": quantity_minor,
                    "price": price,
                    "gross_counter_minor": int(gross_counter_minor),
                    "provider": quote["provider"],
                    "route": route,
                }
            )

        prepared_trades.sort(
            key=lambda row: (
                str(row["account"]),
                int(row["sequence"]),
                int(row["index"]),
            )
        )
        receipts: dict[str, str] = {}
        receipt_owners: dict[str, str] = {}
        settlement_failures: list[dict[str, object]] = []
        audit_frames: list[dict[str, object]] = []
        previous_digest = "0" * 32
        for trade in prepared_trades:
            trade_id = str(trade["trade_id"])
            try:
                proposed_receipt = receipt_writer(trade).strip()
                if not proposed_receipt or len(proposed_receipt) > 512:
                    raise ValueError("invalid receipt")
                owner = receipt_owners.get(proposed_receipt)
                if owner is not None and owner != trade_id:
                    # 收据文本被其它交易占用:防收据复用
                    raise ValueError(f"receipt reused by {owner}")
                receipt_owners[proposed_receipt] = trade_id
                receipts[trade_id] = proposed_receipt
                status = "settled"
                detail = proposed_receipt
            except BaseException as error:
                status = "failed"
                detail = str(error)
                settlement_failures.append(
                    {
                        "trade_id": trade_id,
                        "account": trade["account"],
                        "error": detail,
                    }
                )
            # 审计帧内容:前序摘要 | 交易 ID | 账户 | 状态 | 详情,构成哈希链
            frame_source = (
                f"{previous_digest}|{trade_id}|{trade['account']}|{status}|{detail}"
            ).encode("utf-8")
            digest = hashlib.blake2b(frame_source, digest_size=16).hexdigest()
            audit_frames.append(
                {
                    "index": len(audit_frames),
                    "trade_id": trade_id,
                    "status": status,
                    "previous_digest": previous_digest,
                    "digest": digest,
                }
            )
            previous_digest = digest

        provider_usage = Counter(
            str(trade["provider"])
            for trade in prepared_trades
        )
        route_usage = Counter(
            # 以 "A>B>C" 形式统计路由使用频次
            ">".join(str(hop) for hop in trade["route"])
            for trade in prepared_trades
        )
        quote_ages = [float(quote["age_seconds"]) for quote in selected_quotes.values()]
        spreads = [float(spread) for spread in spread_by_pair.values()]
        rejected_reason_counts = Counter(
            str(reason)
            for row in (*rejected_quotes, *rejected_trades)
            for reason in row["reasons"]
        )
        return {
            "scenario_id": normalized_scenario,
            "observed_at": observed_at,
            "providers": tuple(providers),
            "route_nodes": tuple(sorted(all_route_nodes)),
            "selected_quotes": {
                pair: {
                    "provider": row["provider"],
                    "price": str(row["price"]),
                    "timestamp": row["timestamp"],
                }
                for pair, row in sorted(selected_quotes.items())
            },
            "quote_spreads": {
                pair: str(spread)
                for pair, spread in sorted(spread_by_pair.items())
            },
            "valid_quote_count": len(valid_quotes),
            "rejected_quotes": tuple(rejected_quotes),
            "prepared_trades": tuple(prepared_trades),
            "rejected_trades": tuple(rejected_trades),
            "receipts": dict(sorted(receipts.items())),
            "settlement_failures": tuple(settlement_failures),
            "audit_frames": tuple(audit_frames),
            "final_audit_digest": previous_digest,
            "exposure_by_account": dict(sorted(exposure_by_account.items())),
            "exposure_by_currency": dict(sorted(exposure_by_currency.items())),
            "provider_usage": dict(sorted(provider_usage.items())),
            "route_usage": dict(sorted(route_usage.items())),
            "unresolved_routes": tuple(unresolved_routes),
            "rejected_reason_counts": dict(sorted(rejected_reason_counts.items())),
            "quote_age_average": statistics.fmean(quote_ages) if quote_ages else 0.0,
            "quote_age_maximum": max(quote_ages, default=0.0),
            "spread_average": statistics.fmean(spreads) if spreads else 0.0,
            "settled_count": len(receipts),
            "failed_count": len(settlement_failures),
        }
