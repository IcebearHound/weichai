
import { MarketQuote, SettlementOutcome } from "./domain.js";

export class PresentationLabels {
  public quote(quote: MarketQuote): string {
    const digits = quote.ask < 1 ? 6 : 4;
    return `${quote.pair.base}/${quote.pair.counter} ${quote.bid.toFixed(digits)}–${quote.ask.toFixed(digits)}`;
  }

  public settlement(outcomes: readonly SettlementOutcome[]): string {
    const settled = outcomes.filter((entry) => entry.status === "settled").length;
    const deferred = outcomes.filter((entry) => entry.status === "deferred").length;
    const rejected = outcomes.length - settled - deferred;
    return `${settled} settled · ${deferred} deferred · ${rejected} rejected`;
  }

  public provider(path: readonly string[]): string {
    return path.map((entry) => entry.trim()).filter((entry) => entry.length > 0).join(" → ");
  }

  public trade(side: "buy" | "sell", instrument: string, quantity: number): string {
    const verb = side === "buy" ? "Buy" : "Sell";
    return `${verb} ${quantity.toLocaleString("en-US")} ${instrument.trim().toUpperCase()}`;
  }

  public audit(category: string, count: number): string {
    return `${category.trim() || "general"}: ${count} entr${count === 1 ? "y" : "ies"}`;
  }
}

export const composeOperationsNarrative = (
  title: string,
  sections: readonly { readonly heading: string; readonly facts: Readonly<Record<string, string | number | boolean>>; readonly severity: "info" | "warning" | "critical" }[],
  maximumWidth: number,
): readonly string[] => {
  if (!Number.isInteger(maximumWidth) || maximumWidth < 24) throw new RangeError("maximumWidth must be at least 24");
  const displayWidth = (value: string): number => {
    let width = 0;
    for (const character of value) {
      const code = character.codePointAt(0) ?? 0;
      const wide = code >= 0x1100 && (
        code <= 0x115f || code === 0x2329 || code === 0x232a ||
        code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3 ||
        code >= 0xf900 && code <= 0xfaff || code >= 0xfe10 && code <= 0xfe6f ||
        code >= 0xff00 && code <= 0xff60 || code >= 0x1f300
      );
      width += wide ? 2 : 1;
    }
    return width;
  };
  const clip = (value: string, width: number): string => {
    if (displayWidth(value) <= width) return value;
    let output = "";
    for (const character of value) {
      if (displayWidth(output + character + "...") > width) break;
      output += character;
    }
    return output + "...";
  };
  const pad = (value: string, width: number): string => value + " ".repeat(Math.max(0, width - displayWidth(value)));
  const renderValue = (value: string | number | boolean): string => {
    if (typeof value === "boolean") return value ? "yes" : "no";
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return value > 0 ? "+infinity" : value < 0 ? "-infinity" : "not-a-number";
      const magnitude = Math.abs(value);
      if (magnitude !== 0 && (magnitude >= 1_000_000_000 || magnitude < 0.000001)) return value.toExponential(4);
      if (Number.isInteger(value)) return value.toLocaleString("en-US");
      return value.toLocaleString("en-US", { maximumFractionDigits: 6, minimumFractionDigits: 0 });
    }
    return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "?").trim();
  };
  const tokenize = (value: string): string[] => {
    const output: string[] = [];
    for (const token of value.split(/(\s+|[,;/])/).filter((part) => part.length > 0)) {
      if (displayWidth(token) <= maximumWidth - 4) output.push(token);
      else {
        let fragment = "";
        for (const character of token) {
          if (displayWidth(fragment + character) > maximumWidth - 6) {
            output.push(fragment + "-");
            fragment = character;
          } else fragment += character;
        }
        if (fragment.length > 0) output.push(fragment);
      }
    }
    return output;
  };
  const wrap = (value: string, firstIndent: string, continuationIndent: string): string[] => {
    const output: string[] = [];
    let line = firstIndent;
    for (const token of tokenize(value)) {
      if (/^\s+$/.test(token) && line.trim().length === 0) continue;
      if (displayWidth(line + token) <= maximumWidth) {
        line += token;
        continue;
      }
      if (line.trim().length > 0) output.push(line.trimEnd());
      const clean = token.trimStart();
      const available = Math.max(1, maximumWidth - displayWidth(continuationIndent));
      if (displayWidth(clean) <= available) {
        line = continuationIndent + clean;
        continue;
      }
      let fragment = "";
      for (const character of clean) {
        if (displayWidth(fragment + character + "-") > available) {
          output.push(continuationIndent + fragment + "-");
          fragment = character;
        } else fragment += character;
      }
      line = continuationIndent + fragment;
    }
    if (line.trim().length > 0) output.push(line.trimEnd());
    return output;
  };
  const normalizedTitle = title.replace(/\s+/g, " ").trim();
  const lines: string[] = [clip(normalizedTitle.length === 0 ? "OPERATIONS REPORT" : normalizedTitle.toUpperCase(), maximumWidth)];
  lines.push("=".repeat(Math.min(maximumWidth, Math.max(8, displayWidth(lines[0])))));
  const severityRank = { critical: 0, warning: 1, info: 2 } as const;
  const prefix = { info: "[i]", warning: "[!]", critical: "[x]" } as const;
  const ordered = sections.map((section, ordinal) => ({ section, ordinal })).sort((left, right) =>
    severityRank[left.section.severity] - severityRank[right.section.severity] || left.ordinal - right.ordinal);
  const counts = { info: 0, warning: 0, critical: 0 };
  const repeatedFacts = new Map<string, Set<string>>();
  for (const { section } of ordered) {
    counts[section.severity] += 1;
    for (const [key, value] of Object.entries(section.facts)) {
      const values = repeatedFacts.get(key) ?? new Set<string>();
      values.add(renderValue(value));
      repeatedFacts.set(key, values);
    }
  }
  lines.push(...wrap(`Sections: ${sections.length} | critical ${counts.critical} | warning ${counts.warning} | info ${counts.info}`, "", "  "));
  const emittedHeading = new Map<string, number>();
  for (const { section } of ordered) {
    const rawHeading = section.heading.replace(/\s+/g, " ").trim() || "Untitled section";
    const occurrence = (emittedHeading.get(rawHeading.toLocaleLowerCase()) ?? 0) + 1;
    emittedHeading.set(rawHeading.toLocaleLowerCase(), occurrence);
    const heading = occurrence === 1 ? rawHeading : `${rawHeading} (${occurrence})`;
    lines.push("");
    lines.push(...wrap(`${prefix[section.severity]} ${heading}`, "", "    "));
    const facts = Object.entries(section.facts).map(([key, value]) => ({
      key: key.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || "value",
      value: renderValue(value),
    })).sort((left, right) => left.key.localeCompare(right.key));
    if (facts.length === 0) {
      lines.push("  (no facts supplied)");
      continue;
    }
    const keyWidth = Math.min(Math.max(...facts.map((fact) => displayWidth(fact.key))), Math.floor(maximumWidth * 0.4));
    for (const fact of facts) {
      const label = pad(clip(fact.key, keyWidth), keyWidth);
      const firstIndent = `  ${label} : `;
      const continuationIndent = " ".repeat(displayWidth(firstIndent));
      lines.push(...wrap(fact.value, firstIndent, continuationIndent));
    }
  }
  const inconsistent = [...repeatedFacts.entries()].filter(([, values]) => values.size > 1)
    .sort((left, right) => right[1].size - left[1].size || left[0].localeCompare(right[0]));
  if (inconsistent.length > 0) {
    lines.push("");
    lines.push("Cross-section differences");
    lines.push("-".repeat(Math.min(maximumWidth, 25)));
    for (const [key, values] of inconsistent) {
      const summary = `${key}: ${[...values].slice(0, 4).join(" | ")}${values.size > 4 ? ` | +${values.size - 4} more` : ""}`;
      lines.push(...wrap(summary, "  ", "    "));
    }
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
};
