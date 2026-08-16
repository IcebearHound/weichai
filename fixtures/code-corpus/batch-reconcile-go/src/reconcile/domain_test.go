package reconcile

import (
	"context"
	"encoding/hex"
	"errors"
	"math"
	"strings"
	"testing"
	"time"
)

// TestCurrencyValidityAndMoneyFormatting 验证币种白名单边界(大小写、未知码、
// 空值均非法)以及金额的展示格式(含负号、小数位补零)。
func TestCurrencyValidityAndMoneyFormatting(t *testing.T) {
	valid := []Currency{CurrencyAUD, CurrencyCAD, CurrencyCHF, CurrencyCNY, CurrencyEUR, CurrencyGBP, CurrencyJPY, CurrencyUSD}
	for _, currency := range valid {
		if !currency.Valid() {
			t.Errorf("currency %s should be valid", currency)
		}
	}
	invalid := []Currency{"", "usd", "NZD", "US", "DOLLAR", "123"}
	for _, currency := range invalid {
		if currency.Valid() {
			t.Errorf("currency %q should be invalid", currency)
		}
	}
	cases := []struct {
		money Money
		want  string
	}{
		{Money{Currency: CurrencyUSD, Minor: 0}, "USD 0.00"},
		{Money{Currency: CurrencyEUR, Minor: 7}, "EUR 0.07"},
		{Money{Currency: CurrencyGBP, Minor: 123}, "GBP 1.23"},
		{Money{Currency: CurrencyJPY, Minor: 99_999}, "JPY 999.99"},
		{Money{Currency: CurrencyCHF, Minor: -5}, "-CHF 0.05"},
		{Money{Currency: CurrencyCAD, Minor: -12_345}, "-CAD 123.45"},
	}
	for _, test := range cases {
		if got := test.money.String(); got != test.want {
			t.Errorf("%+v formatted %q, want %q", test.money, got, test.want)
		}
	}
}

// TestMoneyCreationAdditionAndOverflow 验证构造函数对非法币种的拒绝、同币种
// 加减正确、跨币种拒绝,以及正负两侧的溢出保护。
func TestMoneyCreationAdditionAndOverflow(t *testing.T) {
	created, err := NewMoney(CurrencyUSD, 4_250)
	if err != nil || created.Minor != 4_250 {
		t.Fatalf("new money: %+v, %v", created, err)
	}
	if _, err := NewMoney(Currency("BTC"), 1); err == nil {
		t.Error("unsupported currency should fail")
	}
	sum, err := created.Add(Money{Currency: CurrencyUSD, Minor: -250})
	if err != nil || sum.Minor != 4_000 {
		t.Errorf("addition: %+v, %v", sum, err)
	}
	if _, err := created.Add(Money{Currency: CurrencyEUR, Minor: 100}); err == nil {
		t.Error("cross-currency addition should fail")
	}
	if _, err := (Money{Currency: CurrencyUSD, Minor: math.MaxInt64}).Add(Money{Currency: CurrencyUSD, Minor: 1}); err == nil {
		t.Error("positive overflow should fail")
	}
	if _, err := (Money{Currency: CurrencyUSD, Minor: math.MinInt64}).Add(Money{Currency: CurrencyUSD, Minor: -1}); err == nil {
		t.Error("negative overflow should fail")
	}
}

// TestPaymentValidationMatrix 用参数化用例覆盖支付校验的全部规则,包括自转、
// 金额非正、引用超长、优先级越界与属性键值超限等边界。
func TestPaymentValidationMatrix(t *testing.T) {
	base := testPayment("payment-valid", "source-100", "target-200", CurrencyUSD, 5_000, 0)
	if err := base.Validate(); err != nil {
		t.Fatalf("base payment: %v", err)
	}
	tests := []struct {
		name   string
		mutate func(*Payment)
		text   string
	}{
		{"blank identity", func(p *Payment) { p.Identity = "  " }, "identity"},
		{"blank source", func(p *Payment) { p.Account = "" }, "source"},
		{"blank beneficiary", func(p *Payment) { p.Beneficiary = "\t" }, "beneficiary"},
		{"self transfer", func(p *Payment) { p.Beneficiary = p.Account }, "differ"},
		{"unknown currency", func(p *Payment) { p.Amount.Currency = "XYZ" }, "currency"},
		{"zero amount", func(p *Payment) { p.Amount.Minor = 0 }, "positive"},
		{"negative amount", func(p *Payment) { p.Amount.Minor = -1 }, "positive"},
		{"missing time", func(p *Payment) { p.RequestedAt = time.Time{} }, "time"},
		{"long reference", func(p *Payment) { p.Reference = strings.Repeat("r", 141) }, "reference"},
		{"negative priority", func(p *Payment) { p.Priority = -1 }, "priority"},
		{"large priority", func(p *Payment) { p.Priority = 10 }, "priority"},
		{"blank attribute", func(p *Payment) { p.Attributes = map[string]string{" ": "value"} }, "key"},
		{"long attribute key", func(p *Payment) { p.Attributes = map[string]string{strings.Repeat("k", 49): "value"} }, "key"},
		{"long attribute value", func(p *Payment) { p.Attributes = map[string]string{"memo": strings.Repeat("v", 257)} }, "memo"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payment := base
			payment.Attributes = map[string]string{"channel": "api"}
			test.mutate(&payment)
			err := payment.Validate()
			if err == nil || !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(test.text)) {
				t.Errorf("error %v should mention %q", err, test.text)
			}
		})
	}
	many := base
	many.Attributes = make(map[string]string)
	for index := 0; index < 25; index++ {
		many.Attributes[string(rune('a'+index))] = "ok"
	}
	if err := many.Validate(); err == nil || !strings.Contains(err.Error(), "too many") {
		t.Errorf("attribute count error: %v", err)
	}
}

// TestPaymentFingerprintIsCanonicalAndSensitive 验证指纹的规范性(属性插入顺序
// 不影响结果、长度为 64 位十六进制)与敏感性(任意业务字段变化都改变指纹)。
func TestPaymentFingerprintIsCanonicalAndSensitive(t *testing.T) {
	first := testPayment("fingerprint", "account-a", "account-b", CurrencyEUR, 8_888, 0)
	first.Attributes = map[string]string{"zeta": "last", "alpha": "first", "middle": "value"}
	second := first
	second.Attributes = map[string]string{"middle": "value", "alpha": "first", "zeta": "last"}
	if first.Fingerprint() != second.Fingerprint() {
		t.Error("attribute insertion order changed fingerprint")
	}
	if len(first.Fingerprint()) != 64 {
		t.Errorf("fingerprint length %d", len(first.Fingerprint()))
	}
	if _, err := hex.DecodeString(first.Fingerprint()); err != nil {
		t.Errorf("fingerprint is not hexadecimal: %v", err)
	}
	mutations := []func(*Payment){
		func(p *Payment) { p.Identity += "-changed" },
		func(p *Payment) { p.Account += "-changed" },
		func(p *Payment) { p.Beneficiary += "-changed" },
		func(p *Payment) { p.Amount.Minor++ },
		func(p *Payment) { p.Amount.Currency = CurrencyGBP },
		func(p *Payment) { p.RequestedAt = p.RequestedAt.Add(time.Nanosecond) },
		func(p *Payment) { p.Reference += "-changed" },
		func(p *Payment) { p.Priority++ },
		func(p *Payment) { p.ExpectedRoute += "-changed" },
		func(p *Payment) { p.Attributes["alpha"] = "changed" },
	}
	for index, mutate := range mutations {
		changed := first
		changed.Attributes = map[string]string{"zeta": "last", "alpha": "first", "middle": "value"}
		mutate(&changed)
		if changed.Fingerprint() == first.Fingerprint() {
			t.Errorf("mutation %d did not change fingerprint", index)
		}
	}
}

// TestCommitRequestValidationAndFingerprint 验证批次请求的校验规则(键长、空批、
// 尝试次数、时间与截止、批内重复身份),并确认指纹对支付顺序敏感。
func TestCommitRequestValidationAndFingerprint(t *testing.T) {
	paymentA := testPayment("request-a", "src-a", "dst-a", CurrencyUSD, 100, 0)
	paymentB := testPayment("request-b", "src-b", "dst-b", CurrencyEUR, 200, time.Second)
	request := testRequest("request-key-0001", paymentA, paymentB)
	if err := request.Validate(); err != nil {
		t.Fatalf("valid request: %v", err)
	}
	fingerprint := request.Fingerprint()
	if len(fingerprint) != 64 {
		t.Fatalf("fingerprint length %d", len(fingerprint))
	}
	reordered := request
	reordered.Payments = []Payment{paymentB, paymentA}
	if reordered.Fingerprint() == fingerprint {
		t.Error("input order should be part of the batch fingerprint")
	}
	duplicate := request
	duplicate.Payments = []Payment{paymentA, paymentA}
	if err := duplicate.Validate(); err == nil || !strings.Contains(err.Error(), "duplicates") {
		t.Errorf("duplicate validation: %v", err)
	}
	cases := []struct {
		name   string
		mutate func(*CommitRequest)
	}{
		{"short key", func(r *CommitRequest) { r.IdempotencyKey = "short" }},
		{"empty payments", func(r *CommitRequest) { r.Payments = nil }},
		{"zero attempts", func(r *CommitRequest) { r.MaximumAttempts = 0 }},
		{"too many attempts", func(r *CommitRequest) { r.MaximumAttempts = 13 }},
		{"missing requested time", func(r *CommitRequest) { r.RequestedAt = time.Time{} }},
		{"backward deadline", func(r *CommitRequest) { r.Deadline = r.RequestedAt.Add(-time.Second) }},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			changed := request
			test.mutate(&changed)
			if err := changed.Validate(); err == nil {
				t.Error("expected validation failure")
			}
		})
	}
}

// TestReceiptValidationMatrix 验证回执校验:必填引用、正尝试次数、提交时间与
// 证据摘要的十六进制格式及长度。
func TestReceiptValidationMatrix(t *testing.T) {
	valid := Receipt{
		ReceiptID:      "receipt-123",
		PaymentID:      "payment-123",
		BatchKey:       "batch-key-123",
		Account:        "source",
		Beneficiary:    "target",
		Amount:         Money{Currency: CurrencyUSD, Minor: 400},
		Route:          "rail-main",
		ProviderToken:  "provider-token",
		Attempt:        2,
		CommittedAt:    testEpoch,
		EvidenceDigest: strings.Repeat("a", 64),
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid receipt: %v", err)
	}
	tests := []struct {
		name   string
		mutate func(*Receipt)
	}{
		{"blank receipt", func(r *Receipt) { r.ReceiptID = "" }},
		{"blank payment", func(r *Receipt) { r.PaymentID = " " }},
		{"blank batch", func(r *Receipt) { r.BatchKey = "" }},
		{"zero attempt", func(r *Receipt) { r.Attempt = 0 }},
		{"missing commit", func(r *Receipt) { r.CommittedAt = time.Time{} }},
		{"short digest", func(r *Receipt) { r.EvidenceDigest = "abc" }},
		{"bad digest", func(r *Receipt) { r.EvidenceDigest = strings.Repeat("z", 64) }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			changed := valid
			test.mutate(&changed)
			if err := changed.Validate(); err == nil {
				t.Error("expected receipt validation failure")
			}
		})
	}
}

// TestFailureClassification 验证错误分类:context 取消/超时、已分类错误、消息
// 关键词启发式与普通拒绝各自映射到正确的失败类别与可重试性。
func TestFailureClassification(t *testing.T) {
	tests := []struct {
		name      string
		err       error
		kind      FailureKind
		retryable bool
	}{
		{"cancelled", context.Canceled, FailureCancelled, false},
		{"deadline", context.DeadlineExceeded, FailureTimeout, true},
		{"classified transient", transientError("network-reset"), FailureTransient, true},
		{"message timeout", errors.New("upstream TIMEOUT"), FailureTransient, true},
		{"message unavailable", errors.New("service unavailable"), FailureTransient, true},
		{"ordinary rejection", errors.New("invalid beneficiary"), FailurePermanent, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			failure := ClassifyTransferError(test.err)
			if failure.Kind != test.kind || failure.Retryable != test.retryable {
				t.Errorf("classification %+v, want kind=%s retryable=%t", failure, test.kind, test.retryable)
			}
			if !errors.Is(failure, test.err) && test.name != "classified transient" {
				t.Errorf("classification did not retain cause: %v", failure)
			}
		})
	}
	if ClassifyTransferError(nil) != nil {
		t.Error("nil error should classify to nil")
	}
}

// TestBatchSummaryPreservesTotalsAndFailures 验证汇总的正确性:成功/失败计数、
// 总尝试次数、按币种金额累计、失败类别分布与回执 ID 顺序。
func TestBatchSummaryPreservesTotalsAndFailures(t *testing.T) {
	receiptUSD := Receipt{ReceiptID: "r-usd", PaymentID: "p-usd", BatchKey: "summary-batch", Amount: Money{Currency: CurrencyUSD, Minor: 125}, Attempt: 1, CommittedAt: testEpoch, EvidenceDigest: strings.Repeat("1", 64)}
	receiptEUR := Receipt{ReceiptID: "r-eur", PaymentID: "p-eur", BatchKey: "summary-batch", Amount: Money{Currency: CurrencyEUR, Minor: 250}, Attempt: 2, CommittedAt: testEpoch, EvidenceDigest: strings.Repeat("2", 64)}
	entries := []BatchEntry{
		{Position: 0, PaymentID: "p-usd", Receipt: &receiptUSD, Attempts: 1},
		{Position: 1, PaymentID: "p-bad", Attempts: 3, Failure: &CommitFailure{Kind: FailureTimeout, Message: "late"}},
		{Position: 2, PaymentID: "p-eur", Receipt: &receiptEUR, Attempts: 2},
		{Position: 3, PaymentID: "p-denied", Attempts: 1, Failure: &CommitFailure{Kind: FailurePermanent, Message: "denied"}},
	}
	summary := SummarizeBatch("summary-batch", "fingerprint", entries, testEpoch, testEpoch.Add(time.Second))
	if summary.PaymentCount != 4 || summary.SuccessCount != 2 || summary.FailureCount != 2 {
		t.Errorf("summary counts: %+v", summary)
	}
	if summary.AttemptCount != 7 {
		t.Errorf("attempt count %d, want 7", summary.AttemptCount)
	}
	if summary.Currencies[CurrencyUSD].Minor != 125 || summary.Currencies[CurrencyEUR].Minor != 250 {
		t.Errorf("currency totals: %+v", summary.Currencies)
	}
	if summary.FailureKinds[FailureTimeout] != 1 || summary.FailureKinds[FailurePermanent] != 1 {
		t.Errorf("failure kinds: %+v", summary.FailureKinds)
	}
	if strings.Join(summary.ReceiptIDs, ",") != "r-usd,r-eur" {
		t.Errorf("receipt order: %+v", summary.ReceiptIDs)
	}
}
