"""代理编解码适配器。

负责在 BrokerRecord(字节级原始记录)与领域事件(TradeEvent + EventHeaders)
之间双向转换,并把外部 JSON 消息格式的兼容性细节收敛在本模块内,
隔离对上游消息格式的依赖。
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from types import MappingProxyType
from typing import Any

from .model import BrokerRecord, EventHeaders, TradeEvent


class BrokerEventAdapter:
    """BrokerRecord 与领域事件之间的编解码器。

    decode 做严格的字段与类型校验(失败抛 ValueError),确保下游只见到
    结构完整的事件;encode 把事件序列化为紧凑 JSON 并附带关联头。
    """

    def decode(self, record: BrokerRecord) -> tuple[TradeEvent, EventHeaders]:
        """把一条代理原始记录解码为 (TradeEvent, EventHeaders)。

        对负的分区/偏移量、非 JSON 负载、缺失身份字段、非法序列/数量、
        非法时间戳、非法方向等情形均抛 ValueError。
        """
        if record.partition < 0 or record.offset < 0:
            raise ValueError("broker partition and offset must be non-negative")
        try:
            document = json.loads(record.value.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError(f"event payload is not valid UTF-8 JSON: {error}") from error
        if not isinstance(document, dict):
            raise ValueError("event payload must be a JSON object")
        # 同时兼容 camelCase 与 snake_case 两种字段命名,降低上游格式演进成本
        message_value = document.get("messageId", document.get("message_id", ""))
        account_value = document.get("account", document.get("accountId", ""))
        message_id = "" if message_value is None else str(message_value).strip()
        account = "" if account_value is None else str(account_value).strip()
        if not message_id or not account:
            raise ValueError("message identity and account are required")
        # 序列号与数量必须是可解析的数值,缺省或非数值一律视为非法
        try:
            sequence = int(document.get("sequence"))
            quantity = float(document.get("quantity"))
        except (TypeError, ValueError) as error:
            raise ValueError("sequence and quantity must be numeric") from error
        # Z 后缀替换为 +00:00 以兼容 ISO 8601 的 UTC 缩写形式
        occurred_text = str(document.get("occurredAt", document.get("occurred_at", ""))).strip()
        try:
            occurred_at = datetime.fromisoformat(occurred_text.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError(f"invalid occurred-at timestamp {occurred_text!r}") from error
        if occurred_at.tzinfo is None:
            occurred_at = occurred_at.replace(tzinfo=UTC)
        # 方向归一化为小写后做白名单校验,防止脏数据进入下游
        side = str(document.get("side", "")).strip().lower()
        if side not in {"buy", "sell"}:
            raise ValueError(f"unsupported trade side {side!r}")
        instrument_value = document.get("instrument", "")
        instrument = "" if instrument_value is None else str(instrument_value).strip().upper()
        if not instrument:
            raise ValueError("instrument is required")
        tags_value = document.get("tags", [])
        tags = tuple(str(value) for value in tags_value) if isinstance(tags_value, list) else ()
        # 保留字段从负载中剔除,payload 只承载业务自定义字段
        reserved = {
            "messageId",
            "message_id",
            "account",
            "accountId",
            "sequence",
            "quantity",
            "occurredAt",
            "occurred_at",
            "side",
            "instrument",
            "tags",
        }
        payload = MappingProxyType({key: value for key, value in document.items() if key not in reserved})
        # 头键统一转小写,容忍上游大小写不一致
        header_map = {key.lower(): value for key, value in record.headers}
        correlation_bytes = header_map.get("correlation-id", record.key)
        # 关联 ID 缺省回退到记录键;非 UTF-8 时用十六进制表示以保持可追溯
        try:
            correlation_id = correlation_bytes.decode("utf-8")
        except UnicodeDecodeError:
            correlation_id = correlation_bytes.hex()
        attempt_bytes = header_map.get("attempt", b"1")
        # 重试次数下限为 1,避免 0/负值/乱码头破坏后续重试语义
        try:
            attempt = max(1, int(attempt_bytes.decode("ascii")))
        except (UnicodeDecodeError, ValueError):
            attempt = 1
        event = TradeEvent(
            message_id=message_id,
            account=account,
            sequence=sequence,
            occurred_at=occurred_at,
            instrument=instrument,
            side=side,
            quantity=quantity,
            payload=payload,
            tags=tags,
        )
        headers = EventHeaders(
            topic=record.topic,
            partition=record.partition,
            offset=record.offset,
            received_at=record.timestamp,
            correlation_id=correlation_id,
            attempt=attempt,
        )
        return event, headers

    def encode(
        self,
        event: TradeEvent,
        topic: str,
        partition: int,
        offset: int,
        correlation_id: str,
        attempt: int = 1,
    ) -> BrokerRecord:
        """把事件编码为可直接写入代理的 BrokerRecord。

        键使用账户名,便于代理按账户做分区路由;JSON 采用紧凑分隔符并
        关闭 ensure_ascii 以减小体积;payload 字段在末尾展开,保持调用方
        显式字段与负载同名覆盖时的原有兼容行为。
        """
        document: dict[str, Any] = {
            "messageId": event.message_id,
            "account": event.account,
            "sequence": event.sequence,
            "occurredAt": event.occurred_at.isoformat(),
            "instrument": event.instrument,
            "side": event.side,
            "quantity": event.quantity,
            "tags": list(event.tags),
            **dict(event.payload),
        }
        # default=str 兜底序列化非 JSON 原生类型(如日期),避免编码失败
        return BrokerRecord(
            key=event.account.encode("utf-8"),
            value=json.dumps(document, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8"),
            topic=topic,
            partition=partition,
            offset=offset,
            timestamp=datetime.now(UTC),
            headers=(
                ("correlation-id", correlation_id.encode("utf-8")),
                ("attempt", str(max(1, attempt)).encode("ascii")),
            ),
        )
