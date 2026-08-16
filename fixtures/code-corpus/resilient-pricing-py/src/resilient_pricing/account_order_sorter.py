"""账户订单排序器:对账户流内的订单行做规范化排序与顺序体检。

sort 校验并排序订单行(账户/消息 ID 必填、序列号合法),缺序列号的行按配置
排到末尾或开头;ordering_gap_report 汇总每个账户的序列空洞、重复、高水位
与乱序情况,供审计与质检使用。
"""

from __future__ import annotations

import collections
from collections.abc import Mapping, Sequence


class AccountOrderSorter:
    """按账户对订单行排序并生成顺序健康报告。

    missing_sequence_last=True(默认)时缺序列号的行排到末尾,
    反之排到开头;排序键为 (账户, 序列号, 消息 ID, 输入顺序)。
    """

    def __init__(self, missing_sequence_last: bool = True) -> None:
        if not isinstance(missing_sequence_last, bool):
            raise TypeError("missing_sequence_last must be bool")
        self._missing_last = missing_sequence_last

    def sort(self, rows: list[dict[str, object]]) -> list[dict[str, object]]:
        """校验并排序订单行,返回排序后的新列表(不改动入参)。

        逐行校验:账户与 ID 非空、序列号为非负整数或 None;
        缺序列号的行用哨兵值(极大/极小)参与排序以落到两端;
        _input_index 用于保证相同排序键下的稳定次序,排序后移除。
        """
        prepared: list[dict[str, object]] = []
        for index, source in enumerate(rows):
            account = str(source.get("account", "")).strip()
            message_id = str(source.get("id", "")).strip()
            if not account:
                raise ValueError(f"row {index} has an empty account")
            if not message_id:
                raise ValueError(f"row {index} has an empty id")
            raw_sequence = source.get("sequence")
            if raw_sequence is None:
                sequence: int | None = None
            elif isinstance(raw_sequence, int) and not isinstance(raw_sequence, bool):
                if raw_sequence < 0:
                    raise ValueError(f"row {index} has a negative sequence")
                sequence = raw_sequence
            else:
                raise TypeError(f"row {index} sequence must be an integer or None")
            copied = dict(source)
            copied["account"] = account
            copied["id"] = message_id
            copied["sequence"] = sequence
            copied["_input_index"] = index
            prepared.append(copied)

        sentinel = 2**63 - 1 if self._missing_last else -1
        # 缺序列号行用哨兵值参与排序:极大值→末尾,极小值→开头
        prepared.sort(
            key=lambda row: (
                str(row["account"]),
                int(row["sequence"]) if row["sequence"] is not None else sentinel,
                str(row["id"]),
                int(row["_input_index"]),
            )
        )
        for row in prepared:
            row.pop("_input_index")
        return prepared

    def ordering_gap_report(
        self,
        rows: Sequence[Mapping[str, object]],
    ) -> dict[str, object]:
        """对订单行做顺序体检,返回报告。

        - malformed_indexes:账户/ID 缺失或序列号非法的行索引;
        - missing_sequences:序列号缺省的消息 ID;
        - 每个账户:gaps(序列空洞)、duplicate_sequences(重复序号)、
          high_water(最大序号);乱序的账户(到达序 ≠ 排序序)列入
          out_of_order_accounts。
        """
        grouped: dict[str, list[tuple[int, str]]] = collections.defaultdict(list)
        malformed: list[int] = []
        missing_sequences: list[str] = []
        for index, row in enumerate(rows):
            account = str(row.get("account", "")).strip()
            message_id = str(row.get("id", "")).strip()
            raw_sequence = row.get("sequence")
            if not account or not message_id:
                malformed.append(index)
                continue
            if raw_sequence is None:
                missing_sequences.append(message_id)
                continue
            if not isinstance(raw_sequence, int) or isinstance(raw_sequence, bool) or raw_sequence < 0:
                malformed.append(index)
                continue
            grouped[account].append((raw_sequence, message_id))

        gaps: dict[str, tuple[int, ...]] = {}
        duplicate_sequences: dict[str, tuple[int, ...]] = {}
        high_water: dict[str, int] = {}
        out_of_order_accounts: list[str] = []
        for account, entries in sorted(grouped.items()):
            arrival = [sequence for sequence, _message_id in entries]
            ordered = sorted(set(arrival))
            gap_values: list[int] = []
            # 相邻已排序序号之间的整数全部视为空洞
            for left, right in zip(ordered, ordered[1:]):
                gap_values.extend(range(left + 1, right))
            counts = collections.Counter(arrival)
            duplicate_values = sorted(
                sequence for sequence, count in counts.items() if count > 1
            )
            gaps[account] = tuple(gap_values)
            duplicate_sequences[account] = tuple(duplicate_values)
            high_water[account] = max(ordered)
            if arrival != sorted(arrival):
                out_of_order_accounts.append(account)
        return {
            "accounts": len(grouped),
            "rows": sum(len(entries) for entries in grouped.values()),
            "gaps": gaps,
            "gap_count": sum(len(values) for values in gaps.values()),
            "duplicate_sequences": duplicate_sequences,
            "duplicate_count": sum(len(values) for values in duplicate_sequences.values()),
            "high_water": high_water,
            "out_of_order_accounts": tuple(out_of_order_accounts),
            "missing_sequences": tuple(missing_sequences),
            "malformed_indexes": tuple(malformed),
        }
