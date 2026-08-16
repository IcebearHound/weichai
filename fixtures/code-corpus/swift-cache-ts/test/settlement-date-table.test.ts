/**
 * SettlementDateTable 的单元测试:营业日顺延/提前/修正顺延、窗口滚动、
 * 时段分类与节假日观察评估。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  SettlementDateTable,
  type CalendarRule,
} from "../src/settlement-date-table.js";

const day = (isoDate: string): number =>
  Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000;

test("weekends roll in either requested direction", () => {
  // 周六顺延到周一,提前到周五。
  const calendar = new SettlementDateTable();
  const saturday = day("2026-07-11");
  assert.equal(calendar.adjust(saturday, [], "following"), day("2026-07-13"));
  assert.equal(calendar.adjust(saturday, [], "preceding"), day("2026-07-10"));
});

test("explicit closures are observed on weekdays", () => {
  const holiday = day("2026-07-13");
  const rules: CalendarRule[] = [
    { epochDay: holiday, label: "regional holiday", closed: true },
  ];
  const calendar = new SettlementDateTable();
  assert.equal(calendar.adjust(holiday, rules), day("2026-07-14"));
  assert.equal(calendar.adjust(holiday, rules, "preceding"), day("2026-07-10"));
});

test("modified following stays inside the source month", () => {
  // 修正顺延:2026-01-31(周六)不滚到 2 月,而提前回 1 月 30 日。
  const calendar = new SettlementDateTable();
  const saturday = day("2026-01-31");
  assert.equal(calendar.adjust(saturday, [], "following"), day("2026-02-02"));
  assert.equal(
    calendar.adjust(saturday, [], "modified-following"),
    day("2026-01-30"),
  );
});

test("a business day is returned without movement", () => {
  const calendar = new SettlementDateTable();
  const tuesday = day("2026-08-18");
  assert.equal(calendar.adjust(tuesday, []), tuesday);
});

test("rollWindow produces unique increasing business days", () => {
  // 连续 4 个营业日,跳过周末与休市日,输出严格递增。
  const calendar = new SettlementDateTable();
  const rules: CalendarRule[] = [
    { epochDay: day("2026-07-13"), label: "closed", closed: true },
  ];
  const window = calendar.rollWindow(day("2026-07-11"), 4, rules);
  assert.deepEqual(window, [
    day("2026-07-14"),
    day("2026-07-15"),
    day("2026-07-16"),
    day("2026-07-17"),
  ]);
  assert.equal(Object.isFrozen(window), true);
});

test("zero-length windows do not inspect the calendar", () => {
  const calendar = new SettlementDateTable();
  assert.deepEqual(calendar.rollWindow(day("2026-01-01"), 0, []), []);
});

test("session classification handles weekend and cutoff boundaries", () => {
  const calendar = new SettlementDateTable();
  assert.equal(
    calendar.classifySession(Date.parse("2026-07-11T10:00:00Z"), 16),
    "weekend",
  );
  assert.equal(
    calendar.classifySession(Date.parse("2026-07-13T15:59:59Z"), 16),
    "before-cutoff",
  );
  assert.equal(
    calendar.classifySession(Date.parse("2026-07-13T16:00:00Z"), 16),
    "after-cutoff",
  );
});

test("observance inspection reports malformed and missing metadata", () => {
  // 规则键解析失败记入畸形,法域去重后保留大写规范形式。
  const calendar = new SettlementDateTable();
  const summary = calendar.evaluateObservancePolicies({
    calendarId: " gb-lon ",
    anchorEpoch: Date.parse("2026-07-01T00:00:00Z"),
    calendarRules: {
      open: "2026-07-01:open",
      holiday: Date.parse("2026-07-02T00:00:00Z"),
      malformed: "not-a-date",
      ignored: false,
    },
    jurisdictions: [" gb ", "US", "GB", ""],
  });
  assert.equal(summary.calendarId, "gb-lon");
  assert.equal(summary.businessDays, 1);
  assert.equal(summary.closedDays, 1);
  assert.deepEqual(summary.malformedRules, ["ignored", "malformed"]);
  assert.deepEqual(summary.jurisdictions, ["GB", "US"]);
});

test("invalid conventions, counts and cutoffs are rejected", () => {
  const calendar = new SettlementDateTable();
  assert.throws(
    () => calendar.adjust(1, [], "nearest" as never),
    /unsupported/u,
  );
  assert.throws(() => calendar.rollWindow(1, -1, []), /count/u);
  assert.throws(() => calendar.classifySession(0, 25), /cutoffHourUtc/u);
  assert.throws(() => calendar.adjust(1.5, []), /epochDay must be an integer/u);
});

test("search limit protects a calendar closed for too long", () => {
  // 连续 8 天休市超过搜索上限(7 天)时抛错,避免无限搜索。
  const calendar = new SettlementDateTable(7);
  const monday = day("2026-07-13");
  const rules = Array.from({ length: 8 }, (_, offset) => ({
    epochDay: monday + offset,
    label: `closure-${offset}`,
    closed: true,
  }));
  assert.throws(() => calendar.adjust(monday, rules), /no following/u);
});
