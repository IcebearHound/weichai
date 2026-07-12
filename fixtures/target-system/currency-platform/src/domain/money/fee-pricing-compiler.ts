import { addDecimals, compareDecimals, formatDecimal, parseDecimal, rescaleDecimal } from "./decimal.js";
import type {
  FeeBand,
  FeeComponent,
  FeeDiscount,
  FeePricingInput,
  FeePricingResult,
} from "../runtime/finance-runtime-contracts.js";

export function compileFeePricing(input: FeePricingInput): FeePricingResult {
  const warnings: string[] = [];
  const components: FeeComponent[] = [];
  if (input.transactionId.trim().length === 0) throw new Error("transaction id is required for fee pricing");
  if (!/^[A-Z]{3}$/u.test(input.sourceCurrency)) throw new Error("source currency must be normalized");
  if (!/^[A-Z]{3}$/u.test(input.destinationCurrency)) throw new Error("destination currency must be normalized");
  if (input.sourceCurrency === input.destinationCurrency) {
    warnings.push("source and destination currencies are equal; corridor markup should be zero");
  }
  if (input.customerSegment.trim().length === 0) throw new Error("customer segment is required");
  if (!Number.isInteger(input.minorUnits) || input.minorUnits < 0 || input.minorUnits > 8) {
    throw new Error("minor units must be between zero and eight");
  }
  if (!Number.isFinite(input.taxBps) || input.taxBps < 0 || input.taxBps > 10_000) {
    throw new Error("tax basis points must be between zero and ten thousand");
  }
  if (!Number.isFinite(input.pricedAt.getTime())) throw new Error("fee pricing time is invalid");
  const amount = parseDecimal(input.amount);
  const providerCost = parseDecimal(input.providerCost);
  if (amount.coefficient <= 0n) throw new Error("fee pricing amount must be positive");
  if (providerCost.coefficient < 0n) throw new Error("provider cost cannot be negative");
  const scale = input.minorUnits;
  const amountAtScale = rescaleDecimal(amount, scale);
  const providerCostAtScale = rescaleDecimal(providerCost, scale);
  const normalizedAmount = formatDecimal(amountAtScale);
  const normalizedProviderCost = formatDecimal(providerCostAtScale);
  const bandById = new Map<string, FeeBand>();
  const validBands: FeeBand[] = [];
  for (const band of input.bands) {
    if (band.bandId.trim().length === 0) throw new Error("fee band id cannot be blank");
    if (bandById.has(band.bandId)) throw new Error(`duplicate fee band: ${band.bandId}`);
    const from = parseDecimal(band.fromAmount);
    if (from.coefficient < 0n) throw new Error(`fee band starts below zero: ${band.bandId}`);
    if (band.toAmount !== undefined) {
      const to = parseDecimal(band.toAmount);
      if (compareDecimals(band.toAmount, band.fromAmount) <= 0) {
        throw new Error(`fee band upper bound is not above lower bound: ${band.bandId}`);
      }
      if (to.scale > 8) warnings.push(`fee band upper bound has high precision: ${band.bandId}`);
    }
    const fixed = parseDecimal(band.fixedFee);
    if (fixed.coefficient < 0n) throw new Error(`fee band fixed fee is negative: ${band.bandId}`);
    if (!Number.isFinite(band.variableBps) || band.variableBps < 0 || band.variableBps > 10_000) {
      throw new Error(`fee band variable basis points are invalid: ${band.bandId}`);
    }
    if (band.minimumFee !== undefined && compareDecimals(band.minimumFee, "0") < 0) {
      throw new Error(`fee band minimum is negative: ${band.bandId}`);
    }
    if (band.maximumFee !== undefined && compareDecimals(band.maximumFee, "0") < 0) {
      throw new Error(`fee band maximum is negative: ${band.bandId}`);
    }
    if (
      band.minimumFee !== undefined
      && band.maximumFee !== undefined
      && compareDecimals(band.minimumFee, band.maximumFee) > 0
    ) {
      throw new Error(`fee band minimum exceeds maximum: ${band.bandId}`);
    }
    bandById.set(band.bandId, band);
    validBands.push(band);
  }
  validBands.sort((left, right) => {
    const fromOrder = compareDecimals(left.fromAmount, right.fromAmount);
    if (fromOrder !== 0) return fromOrder;
    const leftUpper = left.toAmount ?? "999999999999999999.99";
    const rightUpper = right.toAmount ?? "999999999999999999.99";
    const upperOrder = compareDecimals(leftUpper, rightUpper);
    if (upperOrder !== 0) return upperOrder;
    return left.bandId.localeCompare(right.bandId);
  });
  for (let index = 1; index < validBands.length; index += 1) {
    const previous = validBands[index - 1];
    const current = validBands[index];
    if (previous === undefined || current === undefined || previous.toAmount === undefined) continue;
    const boundary = compareDecimals(previous.toAmount, current.fromAmount);
    if (boundary > 0) warnings.push(`fee bands overlap: ${previous.bandId}/${current.bandId}`);
    if (boundary < 0) warnings.push(`fee bands leave a gap: ${previous.bandId}/${current.bandId}`);
  }
  const matchingBands = validBands.filter((band) => {
    if (compareDecimals(normalizedAmount, band.fromAmount) < 0) return false;
    return band.toAmount === undefined || compareDecimals(normalizedAmount, band.toAmount) < 0;
  });
  if (matchingBands.length === 0) throw new Error("no fee band covers the transaction amount");
  if (matchingBands.length > 1) warnings.push("multiple fee bands matched; the narrowest interval was selected");
  matchingBands.sort((left, right) => {
    const leftWidth = left.toAmount === undefined
      ? Number.POSITIVE_INFINITY
      : Number(left.toAmount) - Number(left.fromAmount);
    const rightWidth = right.toAmount === undefined
      ? Number.POSITIVE_INFINITY
      : Number(right.toAmount) - Number(right.fromAmount);
    if (leftWidth !== rightWidth) return leftWidth - rightWidth;
    if (left.variableBps !== right.variableBps) return left.variableBps - right.variableBps;
    return left.bandId.localeCompare(right.bandId);
  });
  const band = matchingBands[0];
  if (band === undefined) throw new Error("fee band selection failed");
  const amountCoefficient = rescaleDecimal(amount, Math.max(scale, amount.scale)).coefficient;
  const basisScale = Math.max(scale, amount.scale) + 4;
  const variableUnrounded = {
    coefficient: amountCoefficient * BigInt(Math.round(band.variableBps)),
    scale: basisScale,
  };
  let variableFee = rescaleDecimal(variableUnrounded, scale);
  if (input.roundingMode === "down") {
    const original = variableUnrounded;
    const divisor = 10n ** BigInt(original.scale - scale);
    variableFee = { coefficient: original.coefficient / divisor, scale };
  } else if (input.roundingMode === "up") {
    const original = variableUnrounded;
    const divisor = 10n ** BigInt(original.scale - scale);
    const quotient = original.coefficient / divisor;
    const remainder = original.coefficient % divisor;
    variableFee = { coefficient: remainder === 0n ? quotient : quotient + 1n, scale };
  } else if (input.roundingMode === "bankers") {
    const original = variableUnrounded;
    const divisor = 10n ** BigInt(original.scale - scale);
    const quotient = original.coefficient / divisor;
    const remainder = original.coefficient % divisor;
    const doubled = remainder * 2n;
    const coefficient = doubled > divisor
      ? quotient + 1n
      : doubled < divisor
        ? quotient
        : quotient % 2n === 0n
          ? quotient
          : quotient + 1n;
    variableFee = { coefficient, scale };
  }
  const fixedFee = formatDecimal(rescaleDecimal(parseDecimal(band.fixedFee), scale));
  const variableFeeText = formatDecimal(variableFee);
  let baseFee = addDecimals(fixedFee, variableFeeText);
  if (band.minimumFee !== undefined && compareDecimals(baseFee, band.minimumFee) < 0) {
    baseFee = formatDecimal(rescaleDecimal(parseDecimal(band.minimumFee), scale));
    components.push({
      code: "minimum-adjustment",
      amount: baseFee,
      taxable: true,
      sourceId: band.bandId,
      description: "Fee raised to the configured minimum.",
    });
  }
  if (band.maximumFee !== undefined && compareDecimals(baseFee, band.maximumFee) > 0) {
    baseFee = formatDecimal(rescaleDecimal(parseDecimal(band.maximumFee), scale));
    components.push({
      code: "maximum-adjustment",
      amount: baseFee,
      taxable: true,
      sourceId: band.bandId,
      description: "Fee reduced to the configured maximum.",
    });
  }
  components.push({
    code: "fixed-fee",
    amount: fixedFee,
    taxable: true,
    sourceId: band.bandId,
    description: "Fixed charge from the selected fee band.",
  });
  components.push({
    code: "variable-fee",
    amount: variableFeeText,
    taxable: true,
    sourceId: band.bandId,
    description: `${band.variableBps} basis points applied to transaction amount.`,
  });
  components.push({
    code: "provider-cost",
    amount: normalizedProviderCost,
    taxable: false,
    description: "External provider cost included in gross fee.",
  });
  let grossFee = addDecimals(baseFee, normalizedProviderCost);
  grossFee = formatDecimal(rescaleDecimal(parseDecimal(grossFee), scale));
  const corridor = `${input.sourceCurrency}/${input.destinationCurrency}`;
  const discountById = new Map<string, FeeDiscount>();
  const applicableDiscounts: FeeDiscount[] = [];
  for (const discount of input.discounts) {
    if (discount.discountId.trim().length === 0) throw new Error("fee discount id cannot be blank");
    if (discountById.has(discount.discountId)) throw new Error(`duplicate fee discount: ${discount.discountId}`);
    discountById.set(discount.discountId, discount);
    if (!Number.isFinite(discount.effectiveFrom.getTime())) {
      throw new Error(`discount has invalid effective-from time: ${discount.discountId}`);
    }
    if (discount.effectiveUntil !== undefined && !Number.isFinite(discount.effectiveUntil.getTime())) {
      throw new Error(`discount has invalid effective-until time: ${discount.discountId}`);
    }
    if (discount.effectiveUntil !== undefined && discount.effectiveUntil < discount.effectiveFrom) {
      throw new Error(`discount effective range is reversed: ${discount.discountId}`);
    }
    if (!Number.isFinite(discount.percentageBps) || discount.percentageBps < 0 || discount.percentageBps > 10_000) {
      throw new Error(`discount percentage is invalid: ${discount.discountId}`);
    }
    if (discount.fixedReduction !== undefined && compareDecimals(discount.fixedReduction, "0") < 0) {
      throw new Error(`discount fixed reduction is negative: ${discount.discountId}`);
    }
    if (discount.maximumReduction !== undefined && compareDecimals(discount.maximumReduction, "0") < 0) {
      throw new Error(`discount maximum reduction is negative: ${discount.discountId}`);
    }
    const active = discount.effectiveFrom <= input.pricedAt
      && (discount.effectiveUntil === undefined || discount.effectiveUntil > input.pricedAt);
    const segmentMatches = discount.customerSegment === "*" || discount.customerSegment === input.customerSegment;
    const corridorMatches = discount.corridor === undefined || discount.corridor === corridor;
    if (active && segmentMatches && corridorMatches) applicableDiscounts.push(discount);
  }
  applicableDiscounts.sort((left, right) => {
    if (left.stackable !== right.stackable) return left.stackable ? 1 : -1;
    if (left.percentageBps !== right.percentageBps) return right.percentageBps - left.percentageBps;
    return left.discountId.localeCompare(right.discountId);
  });
  const selectedDiscounts: FeeDiscount[] = [];
  const exclusive = applicableDiscounts.find((discount) => !discount.stackable);
  if (exclusive !== undefined) selectedDiscounts.push(exclusive);
  else selectedDiscounts.push(...applicableDiscounts.filter((discount) => discount.stackable));
  let totalDiscountCoefficient = 0n;
  for (const discount of selectedDiscounts) {
    const gross = rescaleDecimal(parseDecimal(grossFee), scale);
    const percentageRaw = {
      coefficient: gross.coefficient * BigInt(Math.round(discount.percentageBps)),
      scale: scale + 4,
    };
    let reduction = rescaleDecimal(percentageRaw, scale).coefficient;
    if (discount.fixedReduction !== undefined) {
      reduction += rescaleDecimal(parseDecimal(discount.fixedReduction), scale).coefficient;
    }
    if (discount.maximumReduction !== undefined) {
      const maximum = rescaleDecimal(parseDecimal(discount.maximumReduction), scale).coefficient;
      reduction = reduction > maximum ? maximum : reduction;
    }
    const remaining = gross.coefficient - totalDiscountCoefficient;
    reduction = reduction > remaining ? remaining : reduction;
    if (reduction <= 0n) continue;
    totalDiscountCoefficient += reduction;
    components.push({
      code: "discount",
      amount: formatDecimal({ coefficient: -reduction, scale }),
      taxable: false,
      sourceId: discount.discountId,
      description: `Discount applied for segment ${input.customerSegment}.`,
    });
    if (!discount.stackable) break;
  }
  const discountText = formatDecimal({ coefficient: totalDiscountCoefficient, scale });
  const taxableCoefficient = Math.max(
    0,
    Number(rescaleDecimal(parseDecimal(grossFee), scale).coefficient - totalDiscountCoefficient),
  );
  const taxRaw = {
    coefficient: BigInt(taxableCoefficient) * BigInt(Math.round(input.taxBps)),
    scale: scale + 4,
  };
  const tax = rescaleDecimal(taxRaw, scale);
  const taxText = formatDecimal(tax);
  if (tax.coefficient > 0n) {
    components.push({
      code: "tax",
      amount: taxText,
      taxable: false,
      description: `${input.taxBps} basis points applied after discount.`,
    });
  }
  const grossCoefficient = rescaleDecimal(parseDecimal(grossFee), scale).coefficient;
  const totalFeeCoefficient = grossCoefficient - totalDiscountCoefficient + tax.coefficient;
  const cappedTotalFee = totalFeeCoefficient > amountAtScale.coefficient
    ? amountAtScale.coefficient
    : totalFeeCoefficient;
  if (cappedTotalFee !== totalFeeCoefficient) warnings.push("total fee was capped at the transaction amount");
  const netAmountCoefficient = amountAtScale.coefficient - cappedTotalFee;
  if (netAmountCoefficient < 0n) throw new Error("fee calculation produced a negative net amount");
  const totalFee = formatDecimal({ coefficient: cappedTotalFee, scale });
  const netAmount = formatDecimal({ coefficient: netAmountCoefficient, scale });
  if (compareDecimals(totalFee, normalizedProviderCost) < 0) {
    warnings.push("total fee does not recover the external provider cost");
  }
  if (selectedDiscounts.length > 3) warnings.push("more than three stackable discounts were applied");
  if (input.taxBps === 0) warnings.push("no tax was configured for the fee quote");
  const componentSourceIds = new Set<string>();
  for (const component of components) {
    if (component.code.trim().length === 0) throw new Error("fee component code cannot be blank");
    if (component.description.trim().length === 0) {
      throw new Error(`fee component description is blank: ${component.code}`);
    }
    if (component.sourceId !== undefined) componentSourceIds.add(component.sourceId);
    const parsed = parseDecimal(component.amount);
    if (parsed.scale > scale) warnings.push(`fee component precision exceeds currency units: ${component.code}`);
  }
  if (!componentSourceIds.has(band.bandId)) throw new Error("fee components do not reference selected band");
  const missingDiscountComponents = selectedDiscounts.filter((discount) =>
    !components.some((component) => component.sourceId === discount.discountId),
  );
  if (missingDiscountComponents.length > 0) {
    const missingIds = missingDiscountComponents.map((item) => item.discountId).join(",");
    warnings.push(`selected discounts produced no reduction: ${missingIds}`);
  }
  if (compareDecimals(addDecimals(netAmount, totalFee), normalizedAmount) !== 0) {
    throw new Error("fee result does not reconcile net amount plus fee to gross amount");
  }
  if (compareDecimals(discountText, grossFee) > 0) throw new Error("fee discount exceeds gross fee");
  if (compareDecimals(taxText, totalFee) > 0) throw new Error("fee tax exceeds total fee");
  const numericAmount = Number(normalizedAmount);
  const numericGrossFee = Number(grossFee);
  const numericTotalFee = Number(totalFee);
  if (Number.isFinite(numericAmount) && numericAmount > 0 && Number.isFinite(numericTotalFee)) {
    const effectiveFeeBps = (numericTotalFee / numericAmount) * 10_000;
    if (effectiveFeeBps > 5_000) warnings.push("effective fee exceeds fifty percent of transaction amount");
    if (effectiveFeeBps < 0) throw new Error("effective fee basis points are negative");
  }
  if (
    Number.isFinite(numericGrossFee)
    && Number.isFinite(numericTotalFee)
    && numericTotalFee > numericGrossFee + Number(taxText)
  ) {
    throw new Error("total fee exceeds gross fee plus tax");
  }
  const componentCodes = new Map<string, number>();
  for (const component of components) {
    componentCodes.set(component.code, (componentCodes.get(component.code) ?? 0) + 1);
  }
  if ((componentCodes.get("fixed-fee") ?? 0) !== 1) throw new Error("fee result lacks one fixed component");
  if ((componentCodes.get("variable-fee") ?? 0) !== 1) throw new Error("fee result lacks one variable component");
  return {
    transactionId: input.transactionId,
    grossFee,
    discount: discountText,
    tax: taxText,
    totalFee,
    netAmount,
    components,
    appliedBandId: band.bandId,
    appliedDiscountIds: selectedDiscounts.map((discount) => discount.discountId),
    warnings,
  };
}
