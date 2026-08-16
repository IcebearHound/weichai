package reconcile

import (
	"strings"
	"testing"
	"time"
)

// ledgerReceipt 构造测试回执:证据摘要固定为 64 个 'c',满足校验要求。
func ledgerReceipt(identity string, currency Currency, minor int64, at time.Time) Receipt {
	return Receipt{
		ReceiptID:      "receipt-" + identity,
		PaymentID:      "payment-" + identity,
		BatchKey:       "ledger-batch-" + identity,
		Account:        "source-" + identity,
		Beneficiary:    "target-" + identity,
		Amount:         Money{Currency: currency, Minor: minor},
		Route:          "ledger-test",
		ProviderToken:  "token-" + identity,
		Attempt:        1,
		CommittedAt:    at,
		EvidenceDigest: strings.Repeat("c", 64),
	}
}

// TestLedgerJournalAppliesBalancedReceiptPostings 验证回执生成的一对借贷分录
// 使双方余额正确增减、修订号递增,且对账无问题。
func TestLedgerJournalAppliesBalancedReceiptPostings(t *testing.T) {
	receipt := ledgerReceipt("balanced", CurrencyUSD, 12_500, testEpoch)
	journal, err := NewLedgerJournal([]AccountBalance{
		{Account: receipt.Account, Currency: CurrencyUSD, Available: 50_000, Revision: 7, UpdatedAt: testEpoch.Add(-time.Hour)},
		{Account: receipt.Beneficiary, Currency: CurrencyUSD, Available: 9_000, Revision: 2, UpdatedAt: testEpoch.Add(-time.Hour)},
	})
	if err != nil {
		t.Fatalf("new journal: %v", err)
	}
	postings, err := BuildReceiptPostings(receipt, map[string]uint64{receipt.Account: 15, receipt.Beneficiary: 30})
	if err != nil {
		t.Fatalf("build postings: %v", err)
	}
	if len(postings) != 2 || postings[0].Direction != PostingDebit || postings[1].Direction != PostingCredit {
		t.Fatalf("unexpected postings: %+v", postings)
	}
	source, err := journal.Apply(postings[0])
	if err != nil {
		t.Fatalf("apply debit: %v", err)
	}
	target, err := journal.Apply(postings[1])
	if err != nil {
		t.Fatalf("apply credit: %v", err)
	}
	if source.Available != 37_500 || source.Revision != 8 {
		t.Errorf("source balance: %+v", source)
	}
	if target.Available != 21_500 || target.Revision != 3 {
		t.Errorf("target balance: %+v", target)
	}
	found, issues := journal.ReconcileReceipt(receipt)
	if len(found) != 2 || len(issues) != 0 {
		t.Errorf("receipt reconciliation found=%+v issues=%+v", found, issues)
	}
}

// TestLedgerJournalIsIdempotentForIdenticalPosting 验证同一条分录重复应用不会
// 重复入账:余额与修订号保持不变,账户流水也只有一行。
func TestLedgerJournalIsIdempotentForIdenticalPosting(t *testing.T) {
	journal, err := NewLedgerJournal(nil)
	if err != nil {
		t.Fatalf("new journal: %v", err)
	}
	posting := LedgerPosting{
		PostingID:    "posting-idempotent",
		ReceiptID:    "receipt-idempotent",
		Account:      "account-idempotent",
		Counterparty: "counterparty-idempotent",
		Amount:       Money{Currency: CurrencyEUR, Minor: 345},
		Direction:    PostingCredit,
		BookedAt:     testEpoch,
		ValueDate:    testEpoch.Truncate(24 * time.Hour),
		Narrative:    "first application",
		Sequence:     1,
	}
	first, err := journal.Apply(posting)
	if err != nil {
		t.Fatalf("first apply: %v", err)
	}
	second, err := journal.Apply(posting)
	if err != nil {
		t.Fatalf("second apply: %v", err)
	}
	if first != second || second.Available != 345 || second.Revision != 1 {
		t.Errorf("idempotent balances differ first=%+v second=%+v", first, second)
	}
	statement := journal.AccountStatement(posting.Account, time.Time{}, time.Time{})
	if len(statement) != 1 {
		t.Errorf("statement has %d duplicate rows", len(statement))
	}
}

// TestLedgerJournalRejectsIdentityConflict 验证同一分录 ID 携带不同内容时被拒绝,
// 且拒绝不会影响已入账的余额。
func TestLedgerJournalRejectsIdentityConflict(t *testing.T) {
	journal, _ := NewLedgerJournal(nil)
	original := LedgerPosting{
		PostingID:    "posting-conflict",
		ReceiptID:    "receipt-conflict",
		Account:      "account-conflict",
		Counterparty: "target-conflict",
		Amount:       Money{Currency: CurrencyGBP, Minor: 700},
		Direction:    PostingDebit,
		BookedAt:     testEpoch,
		ValueDate:    testEpoch,
		Sequence:     1,
	}
	if _, err := journal.Apply(original); err != nil {
		t.Fatalf("original: %v", err)
	}
	changed := original
	changed.Amount.Minor = 701
	if _, err := journal.Apply(changed); err == nil || !strings.Contains(err.Error(), "different") {
		t.Errorf("conflicting posting error: %v", err)
	}
	balance, exists := journal.Balance(original.Account, CurrencyGBP)
	if !exists || balance.Available != -700 {
		t.Errorf("conflict changed balance: %+v exists=%t", balance, exists)
	}
}

// TestLedgerJournalEnforcesSequencePerAccountCurrency 验证每个“账户+币种”流上
// 序号必须严格递增:更小或相等的序号被拒绝,更大序号正常入账。
func TestLedgerJournalEnforcesSequencePerAccountCurrency(t *testing.T) {
	journal, _ := NewLedgerJournal(nil)
	base := LedgerPosting{
		ReceiptID:    "receipt-sequence",
		Account:      "account-sequence",
		Counterparty: "target-sequence",
		Amount:       Money{Currency: CurrencyCAD, Minor: 100},
		Direction:    PostingCredit,
		BookedAt:     testEpoch,
		ValueDate:    testEpoch,
	}
	first := base
	first.PostingID = "sequence-10"
	first.Sequence = 10
	if _, err := journal.Apply(first); err != nil {
		t.Fatalf("first posting: %v", err)
	}
	older := base
	older.PostingID = "sequence-9"
	older.Sequence = 9
	if _, err := journal.Apply(older); err == nil || !strings.Contains(err.Error(), "does not follow") {
		t.Errorf("older sequence error: %v", err)
	}
	equal := base
	equal.PostingID = "sequence-10-again"
	equal.Sequence = 10
	if _, err := journal.Apply(equal); err == nil {
		t.Error("equal sequence should be rejected")
	}
	next := base
	next.PostingID = "sequence-12"
	next.Sequence = 12
	if balance, err := journal.Apply(next); err != nil || balance.Available != 200 {
		t.Errorf("later sequence balance=%+v err=%v", balance, err)
	}
}

// TestLedgerRejectTombstonePreventsFutureApplication 验证拒绝墓碑(仅首次生效)
// 能阻止同名分录后续入账,且被拒分录不产生余额。
func TestLedgerRejectTombstonePreventsFutureApplication(t *testing.T) {
	journal, _ := NewLedgerJournal(nil)
	if !journal.Reject("posting-tombstone", "manual compliance hold") {
		t.Fatal("first tombstone should be recorded")
	}
	if journal.Reject("posting-tombstone", "second reason") {
		t.Error("second tombstone should not replace the first")
	}
	posting := LedgerPosting{
		PostingID:    "posting-tombstone",
		ReceiptID:    "receipt-tombstone",
		Account:      "held-account",
		Counterparty: "held-target",
		Amount:       Money{Currency: CurrencyCHF, Minor: 800},
		Direction:    PostingDebit,
		BookedAt:     testEpoch,
		ValueDate:    testEpoch,
		Sequence:     1,
	}
	if _, err := journal.Apply(posting); err == nil || err.Error() != "manual compliance hold" {
		t.Errorf("tombstone error: %v", err)
	}
	if _, exists := journal.Balance(posting.Account, CurrencyCHF); exists {
		t.Error("rejected posting created a balance")
	}
}

// TestLedgerStatementFiltersAndOrders 验证账户流水按时间窗过滤,并按时序排序。
func TestLedgerStatementFiltersAndOrders(t *testing.T) {
	journal, _ := NewLedgerJournal(nil)
	account := "statement-account"
	for index, offset := range []time.Duration{3 * time.Hour, time.Hour, 4 * time.Hour, 2 * time.Hour} {
		posting := LedgerPosting{
			PostingID:    "statement-" + string(rune('a'+index)),
			ReceiptID:    "receipt-statement",
			Account:      account,
			Counterparty: "statement-target",
			Amount:       Money{Currency: CurrencyCNY, Minor: int64(100 + index)},
			Direction:    PostingCredit,
			BookedAt:     testEpoch.Add(offset),
			ValueDate:    testEpoch,
			Sequence:     uint64(index + 1),
		}
		if _, err := journal.Apply(posting); err != nil {
			t.Fatalf("posting %d: %v", index, err)
		}
	}
	statement := journal.AccountStatement(account, testEpoch.Add(90*time.Minute), testEpoch.Add(4*time.Hour))
	if len(statement) != 2 {
		t.Fatalf("statement length %d, want 2: %+v", len(statement), statement)
	}
	if !statement[0].BookedAt.Equal(testEpoch.Add(2*time.Hour)) || !statement[1].BookedAt.Equal(testEpoch.Add(3*time.Hour)) {
		t.Errorf("statement order: %+v", statement)
	}
}

// TestLedgerOpeningBalancesValidateUniqueness 验证期初余额:“账户+币种”组合
// 必须唯一,空账户被拒绝。
func TestLedgerOpeningBalancesValidateUniqueness(t *testing.T) {
	opening := []AccountBalance{
		{Account: "opening-a", Currency: CurrencyUSD, Available: 100},
		{Account: "opening-a", Currency: CurrencyEUR, Available: 200},
		{Account: "opening-b", Currency: CurrencyUSD, Available: 300},
	}
	journal, err := NewLedgerJournal(opening)
	if err != nil {
		t.Fatalf("distinct opening balances: %v", err)
	}
	if value, exists := journal.Balance("opening-a", CurrencyEUR); !exists || value.Available != 200 {
		t.Errorf("opening balance: %+v exists=%t", value, exists)
	}
	duplicate := append(opening, AccountBalance{Account: "opening-a", Currency: CurrencyUSD, Available: 999})
	if _, err := NewLedgerJournal(duplicate); err == nil || !strings.Contains(err.Error(), "duplicates") {
		t.Errorf("duplicate opening error: %v", err)
	}
	bad := []AccountBalance{{Account: "", Currency: CurrencyUSD}}
	if _, err := NewLedgerJournal(bad); err == nil || !strings.Contains(err.Error(), "invalid") {
		t.Errorf("bad opening error: %v", err)
	}
}

// TestLedgerReconciliationReportsMissingAndMismatchedPostings 验证对账能发现分录
// 缺失、借贷不等、金额与回执不符等问题并逐一报告。
func TestLedgerReconciliationReportsMissingAndMismatchedPostings(t *testing.T) {
	receipt := ledgerReceipt("mismatch", CurrencyAUD, 1_500, testEpoch)
	journal, _ := NewLedgerJournal(nil)
	_, issues := journal.ReconcileReceipt(receipt)
	if len(issues) < 2 {
		t.Fatalf("missing postings issues: %+v", issues)
	}
	posting := LedgerPosting{
		PostingID:    "only-credit",
		ReceiptID:    receipt.ReceiptID,
		Account:      receipt.Beneficiary,
		Counterparty: receipt.Account,
		Amount:       Money{Currency: CurrencyAUD, Minor: 1_400},
		Direction:    PostingCredit,
		BookedAt:     testEpoch,
		ValueDate:    testEpoch,
		Sequence:     1,
	}
	if _, err := journal.Apply(posting); err != nil {
		t.Fatalf("apply single credit: %v", err)
	}
	_, issues = journal.ReconcileReceipt(receipt)
	joined := strings.Join(issues, "|")
	if !strings.Contains(joined, "instead of two") || !strings.Contains(joined, "debits") || !strings.Contains(joined, "receipt") {
		t.Errorf("mismatch issues: %+v", issues)
	}
}

// TestPostingValidationFailures 用参数化用例覆盖分录校验的全部非法输入。
func TestPostingValidationFailures(t *testing.T) {
	base := LedgerPosting{
		PostingID:    "posting-valid",
		ReceiptID:    "receipt-valid",
		Account:      "source-valid",
		Counterparty: "target-valid",
		Amount:       Money{Currency: CurrencyUSD, Minor: 100},
		Direction:    PostingDebit,
		BookedAt:     testEpoch,
		ValueDate:    testEpoch,
		Sequence:     1,
	}
	tests := []struct {
		name   string
		mutate func(*LedgerPosting)
	}{
		{"blank posting", func(p *LedgerPosting) { p.PostingID = "" }},
		{"blank receipt", func(p *LedgerPosting) { p.ReceiptID = "" }},
		{"blank account", func(p *LedgerPosting) { p.Account = "" }},
		{"blank counterparty", func(p *LedgerPosting) { p.Counterparty = "" }},
		{"self posting", func(p *LedgerPosting) { p.Counterparty = p.Account }},
		{"bad currency", func(p *LedgerPosting) { p.Amount.Currency = "ZZZ" }},
		{"zero amount", func(p *LedgerPosting) { p.Amount.Minor = 0 }},
		{"bad direction", func(p *LedgerPosting) { p.Direction = "sideways" }},
		{"missing booked", func(p *LedgerPosting) { p.BookedAt = time.Time{} }},
		{"missing value date", func(p *LedgerPosting) { p.ValueDate = time.Time{} }},
		{"zero sequence", func(p *LedgerPosting) { p.Sequence = 0 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			changed := base
			test.mutate(&changed)
			if err := validatePosting(changed); err == nil {
				t.Error("expected posting validation failure")
			}
		})
	}
}
