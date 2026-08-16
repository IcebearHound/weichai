"""对账器:对比意图、收据与网关行,生成发现与修复计划。

compare 做四类核对:意图唯一性、收据唯一性、网关行引用唯一性,以及
每个意图与收据/网关行的金额、账户一致性;修复计划按发现类别映射到
可执行动作(重放结算、查询网关、导入网关行、隔离行、人工复核等),
并对异常规模生成 incident 告警。
"""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Mapping, Sequence
from decimal import Decimal
from types import MappingProxyType

from .model import DeliveryReceipt, PayoutIntent, ReconcileFinding


class Reconciler:
    """结算对账器。

    compare 输出发现列表(按严重度/类别/身份排序);repair_plan 输出动作计划。
    """

    def compare(
        self,
        intents: Sequence[PayoutIntent],
        receipts: Sequence[DeliveryReceipt],
        gateway_rows: Sequence[Mapping[str, str]],
    ) -> tuple[ReconcileFinding, ...]:
        """对比意图、收据与网关行,返回排序后的对账发现。

        核对项:
        - 意图/收据/网关引用的唯一性(重复即 error);
        - 每个意图:缺收据(missing-receipt)、多个来源收据、
          金额/账户与收据不一致;
        - 收据的网关引用:网关行缺失、金额/币种不一致;
        - 网关行:未被任何收据引用(orphan)。

        返回按 (error→warning→info, 类别, 身份) 排序。
        """
        findings: list[ReconcileFinding] = []
        intent_by_identity: dict[str, PayoutIntent] = {}
        for intent in intents:
            if intent.identity in intent_by_identity:
                findings.append(
                    ReconcileFinding(
                        identity=intent.identity,
                        severity="error",
                        category="duplicate-intent",
                        expected="one unique intent",
                        observed="multiple records",
                        repairable=False,
                    )
                )
                continue
            intent_by_identity[intent.identity] = intent
        receipt_by_key: dict[str, DeliveryReceipt] = {}
        for receipt in receipts:
            existing = receipt_by_key.get(receipt.idempotency_key)
            if existing is not None and existing.receipt_id != receipt.receipt_id:
                findings.append(
                    ReconcileFinding(
                        identity=receipt.idempotency_key,
                        severity="error",
                        category="duplicate-receipt",
                        expected=existing.receipt_id,
                        observed=receipt.receipt_id,
                        repairable=False,
                    )
                )
                continue
            receipt_by_key[receipt.idempotency_key] = receipt
        gateway_by_reference: dict[str, Mapping[str, str]] = {}
        for ordinal, row in enumerate(gateway_rows):
            reference = row.get("reference", "").strip()
            if not reference:
                findings.append(
                    ReconcileFinding(
                        identity=f"gateway:{ordinal}",
                        severity="warning",
                        category="gateway-reference",
                        expected="non-empty reference",
                        observed="empty",
                        repairable=True,
                    )
                )
                continue
            if reference in gateway_by_reference:
                findings.append(
                    ReconcileFinding(
                        identity=reference,
                        severity="error",
                        category="gateway-duplicate",
                        expected="one gateway row",
                        observed="multiple rows",
                        repairable=False,
                    )
                )
            gateway_by_reference[reference] = row
        receipts_by_source: dict[str, list[DeliveryReceipt]] = defaultdict(list)
        for receipt in receipts:
            source = str(receipt.metadata.get("source_identity", receipt.idempotency_key))
            receipts_by_source[source].append(receipt)
        for identity, intent in intent_by_identity.items():
            linked = receipts_by_source.get(identity, [])
            if not linked:
                # 意图没有对应收据:可重放修复
                findings.append(
                    ReconcileFinding(
                        identity=identity,
                        severity="warning",
                        category="missing-receipt",
                        expected="receipt",
                        observed="none",
                        repairable=True,
                        context=MappingProxyType({"account": intent.account, "currency": intent.money.currency}),
                    )
                )
                continue
            if len(linked) > 1:
                findings.append(
                    ReconcileFinding(
                        identity=identity,
                        severity="error",
                        category="multiple-source-receipts",
                        expected="one",
                        observed=str(len(linked)),
                        repairable=False,
                    )
                )
            receipt = linked[0]
            if receipt.money != intent.money:
                findings.append(
                    ReconcileFinding(
                        identity=identity,
                        severity="error",
                        category="money-mismatch",
                        expected=f"{intent.money.currency}:{intent.money.amount}",
                        observed=f"{receipt.money.currency}:{receipt.money.amount}",
                        repairable=False,
                    )
                )
            if receipt.account != intent.account:
                findings.append(
                    ReconcileFinding(
                        identity=identity,
                        severity="error",
                        category="account-mismatch",
                        expected=intent.account,
                        observed=receipt.account,
                        repairable=False,
                    )
                )
            gateway = gateway_by_reference.get(receipt.gateway_reference)
            if gateway is None:
                # 收据引用了不存在的网关行:可查询修复
                findings.append(
                    ReconcileFinding(
                        identity=identity,
                        severity="warning",
                        category="missing-gateway-row",
                        expected=receipt.gateway_reference,
                        observed="none",
                        repairable=True,
                    )
                )
                continue
            gateway_amount = Decimal(gateway.get("amount", "NaN"))
            gateway_currency = gateway.get("currency", "").upper()
            if gateway_amount != receipt.money.amount or gateway_currency != receipt.money.currency.upper():
                findings.append(
                    ReconcileFinding(
                        identity=identity,
                        severity="error",
                        category="gateway-money",
                        expected=f"{receipt.money.currency}:{receipt.money.amount}",
                        observed=f"{gateway_currency}:{gateway_amount}",
                        repairable=False,
                    )
                )
        used_references = {receipt.gateway_reference for receipt in receipts}
        for reference, row in gateway_by_reference.items():
            if reference in used_references:
                continue
            findings.append(
                ReconcileFinding(
                    identity=reference,
                    severity="warning",
                    category="orphan-gateway-row",
                    expected="linked receipt",
                    observed=row.get("status", "unknown"),
                    repairable=True,
                )
            )
        severity_rank = {"error": 0, "warning": 1, "info": 2}
        return tuple(sorted(findings, key=lambda item: (severity_rank[item.severity], item.category, item.identity)))

    def repair_plan(self, findings: Sequence[ReconcileFinding]) -> Mapping[str, tuple[str, ...]]:
        """把对账发现映射为修复动作计划。

        按类别映射:missing-receipt→重放结算,missing-gateway-row→查询网关,
        orphan-gateway-row→导入网关行,gateway-reference→隔离行;
        不可修复的进 manual-review;异常规模(缺收据 >10、网关重复)产生 incident。
        返回 {动作: 目标列表}。
        """
        actions: dict[str, list[str]] = defaultdict(list)
        counts = Counter(finding.category for finding in findings)
        for finding in findings:
            if not finding.repairable:
                actions["manual-review"].append(f"{finding.identity}:{finding.category}")
                continue
            if finding.category == "missing-receipt":
                actions["replay-settlement"].append(finding.identity)
            elif finding.category == "missing-gateway-row":
                actions["query-gateway"].append(finding.expected)
            elif finding.category == "orphan-gateway-row":
                actions["import-gateway-row"].append(finding.identity)
            elif finding.category == "gateway-reference":
                actions["quarantine-row"].append(finding.identity)
            else:
                actions["investigate"].append(f"{finding.identity}:{finding.category}")
        if counts["missing-receipt"] > 10:
            actions["incident"].append(f"receipt-gap-burst:{counts['missing-receipt']}")
        if counts["gateway-duplicate"] > 0:
            actions["incident"].append(f"gateway-duplicates:{counts['gateway-duplicate']}")
        return MappingProxyType(
            {
                action: tuple(dict.fromkeys(values))
                for action, values in sorted(actions.items())
                if values
            }
        )
