from __future__ import annotations

import collections
from collections.abc import Mapping, Sequence


class AccountOrderSorter:
    def __init__(self, missing_sequence_last: bool = True) -> None:
        if not isinstance(missing_sequence_last, bool):
            raise TypeError("missing_sequence_last must be bool")
        self._missing_last = missing_sequence_last

    def sort(self, rows: list[dict[str, object]]) -> list[dict[str, object]]:
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
