package reconcile

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

type Currency string

const (
	CurrencyAUD Currency = "AUD"
	CurrencyCAD Currency = "CAD"
	CurrencyCHF Currency = "CHF"
	CurrencyCNY Currency = "CNY"
	CurrencyEUR Currency = "EUR"
	CurrencyGBP Currency = "GBP"
	CurrencyJPY Currency = "JPY"
	CurrencyUSD Currency = "USD"
)

type Money struct {
	Currency Currency
	Minor    int64
}

func NewMoney(currency Currency, minor int64) (Money, error) {
	if !currency.Valid() {
		return Money{}, fmt.Errorf("unsupported currency %q", currency)
	}
	return Money{Currency: currency, Minor: minor}, nil
}

func (currency Currency) Valid() bool {
	switch currency {
	case CurrencyAUD, CurrencyCAD, CurrencyCHF, CurrencyCNY,
		CurrencyEUR, CurrencyGBP, CurrencyJPY, CurrencyUSD:
		return true
	default:
		return false
	}
}

func (money Money) Add(other Money) (Money, error) {
	if money.Currency != other.Currency {
		return Money{}, fmt.Errorf("currency mismatch: %s and %s", money.Currency, other.Currency)
	}
	if other.Minor > 0 && money.Minor > int64(^uint64(0)>>1)-other.Minor {
		return Money{}, errors.New("money addition overflow")
	}
	if other.Minor < 0 && money.Minor < -int64(^uint64(0)>>1)-1-other.Minor {
		return Money{}, errors.New("money addition underflow")
	}
	return Money{Currency: money.Currency, Minor: money.Minor + other.Minor}, nil
}

func (money Money) String() string {
	negative := money.Minor < 0
	absolute := money.Minor
	if negative {
		absolute = -absolute
	}
	major := absolute / 100
	fraction := absolute % 100
	prefix := ""
	if negative {
		prefix = "-"
	}
	return fmt.Sprintf("%s%s %d.%02d", prefix, money.Currency, major, fraction)
}

type Payment struct {
	Identity      string
	Account       string
	Beneficiary   string
	Amount        Money
	RequestedAt   time.Time
	Reference     string
	Attributes    map[string]string
	Priority      int
	ExpectedRoute string
}

func (payment Payment) Validate() error {
	if strings.TrimSpace(payment.Identity) == "" {
		return errors.New("payment identity is required")
	}
	if strings.TrimSpace(payment.Account) == "" {
		return errors.New("source account is required")
	}
	if strings.TrimSpace(payment.Beneficiary) == "" {
		return errors.New("beneficiary is required")
	}
	if payment.Account == payment.Beneficiary {
		return errors.New("source and beneficiary must differ")
	}
	if !payment.Amount.Currency.Valid() {
		return errors.New("payment currency is unsupported")
	}
	if payment.Amount.Minor <= 0 {
		return errors.New("payment amount must be positive")
	}
	if payment.RequestedAt.IsZero() {
		return errors.New("requested time is required")
	}
	if len(payment.Reference) > 140 {
		return errors.New("reference exceeds 140 characters")
	}
	if payment.Priority < 0 || payment.Priority > 9 {
		return errors.New("priority must be between zero and nine")
	}
	if len(payment.Attributes) > 24 {
		return errors.New("too many payment attributes")
	}
	for key, value := range payment.Attributes {
		if strings.TrimSpace(key) == "" || len(key) > 48 {
			return errors.New("invalid payment attribute key")
		}
		if len(value) > 256 {
			return fmt.Errorf("attribute %s exceeds 256 characters", key)
		}
	}
	return nil
}

func (payment Payment) Fingerprint() string {
	keys := make([]string, 0, len(payment.Attributes))
	for key := range payment.Attributes {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	hash := sha256.New()
	writeFingerprintPart(hash, payment.Identity)
	writeFingerprintPart(hash, payment.Account)
	writeFingerprintPart(hash, payment.Beneficiary)
	writeFingerprintPart(hash, string(payment.Amount.Currency))
	writeFingerprintPart(hash, strconv.FormatInt(payment.Amount.Minor, 10))
	writeFingerprintPart(hash, payment.RequestedAt.UTC().Format(time.RFC3339Nano))
	writeFingerprintPart(hash, payment.Reference)
	writeFingerprintPart(hash, strconv.Itoa(payment.Priority))
	writeFingerprintPart(hash, payment.ExpectedRoute)
	for _, key := range keys {
		writeFingerprintPart(hash, key)
		writeFingerprintPart(hash, payment.Attributes[key])
	}
	return hex.EncodeToString(hash.Sum(nil))
}

type CommitRequest struct {
	IdempotencyKey  string
	Payments        []Payment
	MaximumAttempts int
	RequestedAt     time.Time
	Deadline        time.Time
}

func (request CommitRequest) Validate() error {
	key := strings.TrimSpace(request.IdempotencyKey)
	if len(key) < 8 || len(key) > 128 {
		return errors.New("idempotency key length must be between 8 and 128")
	}
	if len(request.Payments) == 0 {
		return errors.New("batch must contain at least one payment")
	}
	if len(request.Payments) > 2_000 {
		return errors.New("batch exceeds 2000 payments")
	}
	if request.MaximumAttempts < 1 || request.MaximumAttempts > 12 {
		return errors.New("maximum attempts must be between one and twelve")
	}
	if request.RequestedAt.IsZero() {
		return errors.New("batch requested time is required")
	}
	if !request.Deadline.IsZero() && !request.Deadline.After(request.RequestedAt) {
		return errors.New("deadline must follow requested time")
	}
	identities := make(map[string]struct{}, len(request.Payments))
	for position, payment := range request.Payments {
		if err := payment.Validate(); err != nil {
			return fmt.Errorf("payment %d: %w", position, err)
		}
		if _, exists := identities[payment.Identity]; exists {
			return fmt.Errorf("payment %d duplicates identity %s", position, payment.Identity)
		}
		identities[payment.Identity] = struct{}{}
	}
	return nil
}

func (request CommitRequest) Fingerprint() string {
	hash := sha256.New()
	writeFingerprintPart(hash, strings.TrimSpace(request.IdempotencyKey))
	writeFingerprintPart(hash, request.RequestedAt.UTC().Format(time.RFC3339Nano))
	writeFingerprintPart(hash, request.Deadline.UTC().Format(time.RFC3339Nano))
	writeFingerprintPart(hash, strconv.Itoa(request.MaximumAttempts))
	for _, payment := range request.Payments {
		writeFingerprintPart(hash, payment.Fingerprint())
	}
	return hex.EncodeToString(hash.Sum(nil))
}

type Receipt struct {
	ReceiptID      string
	PaymentID      string
	BatchKey       string
	Account        string
	Beneficiary    string
	Amount         Money
	Route          string
	ProviderToken  string
	Attempt        int
	CommittedAt    time.Time
	EvidenceDigest string
}

func (receipt Receipt) Validate() error {
	if strings.TrimSpace(receipt.ReceiptID) == "" {
		return errors.New("receipt identity is required")
	}
	if strings.TrimSpace(receipt.PaymentID) == "" || strings.TrimSpace(receipt.BatchKey) == "" {
		return errors.New("receipt payment and batch references are required")
	}
	if receipt.Attempt < 1 {
		return errors.New("receipt attempt must be positive")
	}
	if receipt.CommittedAt.IsZero() {
		return errors.New("receipt commit time is required")
	}
	if len(receipt.EvidenceDigest) != 64 {
		return errors.New("receipt evidence digest must contain 64 hexadecimal characters")
	}
	if _, err := hex.DecodeString(receipt.EvidenceDigest); err != nil {
		return errors.New("receipt evidence digest is not hexadecimal")
	}
	return nil
}

type TransferResult struct {
	ProviderToken string
	Route         string
	CommittedAt   time.Time
	Metadata      map[string]string
}

type BatchEntry struct {
	Position  int
	PaymentID string
	Receipt   *Receipt
	Attempts  int
	Failure   *CommitFailure
}

func (entry BatchEntry) Successful() bool {
	return entry.Receipt != nil && entry.Failure == nil
}

type FailureKind string

const (
	FailureCancelled   FailureKind = "cancelled"
	FailureConflict    FailureKind = "conflict"
	FailureInvalid     FailureKind = "invalid"
	FailurePermanent   FailureKind = "permanent"
	FailureRetryBudget FailureKind = "retry-budget"
	FailureTimeout     FailureKind = "timeout"
	FailureTransient   FailureKind = "transient"
)

type CommitFailure struct {
	Kind      FailureKind
	Message   string
	Retryable bool
	Cause     error
}

func (failure *CommitFailure) Error() string {
	if failure == nil {
		return ""
	}
	if failure.Cause == nil {
		return string(failure.Kind) + ": " + failure.Message
	}
	return string(failure.Kind) + ": " + failure.Message + ": " + failure.Cause.Error()
}

func (failure *CommitFailure) Unwrap() error {
	if failure == nil {
		return nil
	}
	return failure.Cause
}

type BatchSummary struct {
	BatchKey     string
	Fingerprint  string
	PaymentCount int
	SuccessCount int
	FailureCount int
	AttemptCount int
	StartedAt    time.Time
	FinishedAt   time.Time
	Currencies   map[Currency]Money
	FailureKinds map[FailureKind]int
	ReceiptIDs   []string
}

func SummarizeBatch(key, fingerprint string, entries []BatchEntry, started, finished time.Time) BatchSummary {
	summary := BatchSummary{
		BatchKey:     key,
		Fingerprint:  fingerprint,
		PaymentCount: len(entries),
		StartedAt:    started,
		FinishedAt:   finished,
		Currencies:   make(map[Currency]Money),
		FailureKinds: make(map[FailureKind]int),
	}
	for _, entry := range entries {
		summary.AttemptCount += entry.Attempts
		if entry.Successful() {
			summary.SuccessCount++
			receipt := *entry.Receipt
			total := summary.Currencies[receipt.Amount.Currency]
			if total.Currency == "" {
				total.Currency = receipt.Amount.Currency
			}
			total.Minor += receipt.Amount.Minor
			summary.Currencies[receipt.Amount.Currency] = total
			summary.ReceiptIDs = append(summary.ReceiptIDs, receipt.ReceiptID)
		} else {
			summary.FailureCount++
			if entry.Failure != nil {
				summary.FailureKinds[entry.Failure.Kind]++
			}
		}
	}
	return summary
}

type ValidationIssue struct {
	Position int
	Field    string
	Code     string
	Message  string
}

type BatchConflictError struct {
	Key                 string
	ExistingFingerprint string
	IncomingFingerprint string
}

func (conflict *BatchConflictError) Error() string {
	return fmt.Sprintf("idempotency key %q already names a different batch", conflict.Key)
}

func writeFingerprintPart(target interface{ Write([]byte) (int, error) }, value string) {
	length := strconv.Itoa(len(value))
	_, _ = target.Write([]byte(length))
	_, _ = target.Write([]byte{':'})
	_, _ = target.Write([]byte(value))
	_, _ = target.Write([]byte{'|'})
}
