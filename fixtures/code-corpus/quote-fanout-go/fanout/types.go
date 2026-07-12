package fanout

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

type Pair struct {
	Base    string
	Counter string
}

type Quote struct {
	Pair       Pair
	BidMicros  int64
	AskMicros  int64
	Provider   string
	ObservedAt time.Time
	ExpiresAt  time.Time
	Stale      bool
	Tags       map[string]string
}

type QuoteRequest struct {
	Pair          Pair
	AmountMinor   int64
	RequestedAt   time.Time
	CorrelationID string
	Region        string
}

func (request QuoteRequest) Validate(now time.Time) error {
	pair, err := ParsePair(request.Pair.String())
	if err != nil {
		return err
	}
	if pair != request.Pair {
		return errors.New("quote request pair is not normalized")
	}
	if request.AmountMinor <= 0 {
		return errors.New("quote request amount must be positive")
	}
	if request.AmountMinor > 1_000_000_000_000_000 {
		return errors.New("quote request amount exceeds platform range")
	}
	if request.RequestedAt.IsZero() {
		return errors.New("quote request time is missing")
	}
	if !now.IsZero() {
		if request.RequestedAt.After(now.Add(time.Minute)) {
			return errors.New("quote request time is too far in the future")
		}
		if request.RequestedAt.Before(now.Add(-30 * 24 * time.Hour)) {
			return errors.New("quote request time is older than thirty days")
		}
	}
	if len(request.CorrelationID) < 3 || len(request.CorrelationID) > 80 {
		return errors.New("quote request correlation identifier length is invalid")
	}
	for index, character := range request.CorrelationID {
		allowed := character >= 'a' && character <= 'z' ||
			character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' ||
			character == '.' || character == '_' || character == ':' || character == '-'
		if !allowed {
			return fmt.Errorf("quote request correlation identifier has unsafe character at %d", index)
		}
	}
	if strings.Contains(request.CorrelationID, "..") || strings.Contains(request.CorrelationID, "::") {
		return errors.New("quote request correlation identifier has an empty segment")
	}
	if request.Region == "" || len(request.Region) > 64 {
		return errors.New("quote request region is invalid")
	}
	for index, character := range request.Region {
		allowed := character >= 'a' && character <= 'z' ||
			character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' || character == '-'
		if !allowed {
			return fmt.Errorf("quote request region has unsafe character at %d", index)
		}
	}
	if request.Pair.Base == "XTS" || request.Pair.Counter == "XTS" {
		return errors.New("quote request cannot use the reserved test currency")
	}
	return nil
}

type QuoteProvider interface {
	Name() string
	Fetch(context.Context, QuoteRequest) (Quote, error)
}

type Clock interface {
	Now() time.Time
}

type SystemClock struct{}

func (SystemClock) Now() time.Time {
	return time.Now().UTC()
}

type ProviderFailure struct {
	Provider  string
	Kind      string
	Retryable bool
	Cause     error
}

func (failure ProviderFailure) Error() string {
	message := "provider request failed"
	if failure.Cause != nil {
		message = failure.Cause.Error()
	}
	return fmt.Sprintf("%s: %s (%s)", failure.Provider, message, failure.Kind)
}

func (failure ProviderFailure) Unwrap() error {
	return failure.Cause
}

var (
	ErrInvalidPair       = errors.New("currency pair is invalid")
	ErrQuoteUnavailable  = errors.New("quote is unavailable")
	ErrProviderOpen      = errors.New("provider circuit is open")
	ErrProbeBusy         = errors.New("provider recovery probe is already running")
	ErrBatcherClosed     = errors.New("journal batcher is closed")
	ErrDuplicateMessage  = errors.New("message was already processed")
	ErrAccountLaneBusy   = errors.New("account lane is busy")
	ErrSettlementCutoff  = errors.New("settlement cutoff has passed")
	ErrUnsupportedRegion = errors.New("region is unsupported")
)

func ParsePair(text string) (Pair, error) {
	trimmed := strings.TrimSpace(text)
	if len(trimmed) != 7 {
		return Pair{}, fmt.Errorf("%w: expected seven characters", ErrInvalidPair)
	}
	separator := strings.IndexByte(trimmed, '/')
	if separator != 3 {
		return Pair{}, fmt.Errorf("%w: expected slash after base code", ErrInvalidPair)
	}
	base := strings.ToUpper(trimmed[:separator])
	counter := strings.ToUpper(trimmed[separator+1:])
	for _, code := range []string{base, counter} {
		if len(code) != 3 {
			return Pair{}, fmt.Errorf("%w: currency code length", ErrInvalidPair)
		}
		for _, character := range code {
			if character < 'A' || character > 'Z' {
				return Pair{}, fmt.Errorf("%w: currency code alphabet", ErrInvalidPair)
			}
		}
		if code == "XXX" || code == "ZZZ" {
			return Pair{}, fmt.Errorf("%w: reserved currency %s", ErrInvalidPair, code)
		}
	}
	if base == counter {
		return Pair{}, fmt.Errorf("%w: identical currencies", ErrInvalidPair)
	}
	return Pair{Base: base, Counter: counter}, nil
}

func (pair Pair) String() string {
	return pair.Base + "/" + pair.Counter
}

func (pair Pair) Inverse() Pair {
	return Pair{Base: pair.Counter, Counter: pair.Base}
}

func (quote Quote) Validate(now time.Time) error {
	parsed, err := ParsePair(quote.Pair.String())
	if err != nil {
		return err
	}
	if parsed != quote.Pair {
		return fmt.Errorf("quote pair is not normalized: %s", quote.Pair.String())
	}
	if quote.Provider == "" {
		return errors.New("quote provider is empty")
	}
	if len(quote.Provider) > 64 {
		return errors.New("quote provider name is too long")
	}
	for _, character := range quote.Provider {
		if !(character == '-' || character == '_' || character == '.' ||
			character >= 'a' && character <= 'z' ||
			character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9') {
			return errors.New("quote provider contains an unsafe character")
		}
	}
	if quote.BidMicros <= 0 {
		return errors.New("quote bid must be positive")
	}
	if quote.AskMicros < quote.BidMicros {
		return errors.New("quote ask must not be below bid")
	}
	if quote.AskMicros > math.MaxInt64/2 {
		return errors.New("quote ask exceeds supported range")
	}
	if quote.ObservedAt.IsZero() {
		return errors.New("quote observation time is missing")
	}
	if quote.ExpiresAt.IsZero() {
		return errors.New("quote expiry time is missing")
	}
	if quote.ExpiresAt.Before(quote.ObservedAt) {
		return errors.New("quote expires before observation")
	}
	if quote.ExpiresAt.Sub(quote.ObservedAt) > 24*time.Hour {
		return errors.New("quote lifetime exceeds one day")
	}
	if !now.IsZero() && quote.ObservedAt.After(now.Add(time.Minute)) {
		return errors.New("quote observation is in the future")
	}
	if len(quote.Tags) > 32 {
		return errors.New("quote has too many tags")
	}
	keys := make([]string, 0, len(quote.Tags))
	for key, value := range quote.Tags {
		if strings.TrimSpace(key) == "" {
			return errors.New("quote tag key is empty")
		}
		if len(key) > 40 || len(value) > 200 {
			return errors.New("quote tag exceeds length limit")
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for index := 1; index < len(keys); index++ {
		if strings.EqualFold(keys[index-1], keys[index]) {
			return errors.New("quote tag keys differ only by case")
		}
	}
	return nil
}

func (quote Quote) MidpointMicros() (int64, error) {
	if quote.BidMicros <= 0 || quote.AskMicros < quote.BidMicros {
		return 0, errors.New("cannot compute midpoint for invalid quote")
	}
	if quote.BidMicros > math.MaxInt64-quote.AskMicros {
		return 0, errors.New("midpoint addition overflow")
	}
	return (quote.BidMicros + quote.AskMicros) / 2, nil
}

func (quote Quote) SpreadBasisPoints() (float64, error) {
	midpoint, err := quote.MidpointMicros()
	if err != nil {
		return 0, err
	}
	if midpoint == 0 {
		return 0, errors.New("cannot divide spread by zero midpoint")
	}
	spread := quote.AskMicros - quote.BidMicros
	result := float64(spread) / float64(midpoint) * 10_000
	if math.IsNaN(result) || math.IsInf(result, 0) {
		return 0, errors.New("spread calculation is non-finite")
	}
	return result, nil
}

func CanonicalAmount(text string, minorUnits int) (int64, error) {
	if minorUnits < 0 || minorUnits > 8 {
		return 0, errors.New("minor units must be between zero and eight")
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return 0, errors.New("amount cannot be empty")
	}
	if strings.HasPrefix(trimmed, "+") {
		return 0, errors.New("amount cannot have a leading plus sign")
	}
	if strings.ContainsAny(trimmed, "eE,_") {
		return 0, errors.New("amount uses an unsupported numeric notation")
	}
	negative := strings.HasPrefix(trimmed, "-")
	if negative {
		trimmed = trimmed[1:]
	}
	parts := strings.Split(trimmed, ".")
	if len(parts) > 2 || parts[0] == "" {
		return 0, errors.New("amount decimal syntax is invalid")
	}
	for _, part := range parts {
		for _, character := range part {
			if character < '0' || character > '9' {
				return 0, errors.New("amount contains a non-digit")
			}
		}
	}
	fraction := ""
	if len(parts) == 2 {
		fraction = parts[1]
	}
	if len(fraction) > minorUnits {
		return 0, errors.New("amount has too many fractional digits")
	}
	fraction += strings.Repeat("0", minorUnits-len(fraction))
	digits := strings.TrimLeft(parts[0]+fraction, "0")
	if digits == "" {
		digits = "0"
	}
	if len(digits) > 18 {
		return 0, errors.New("amount exceeds signed 64-bit range")
	}
	value, err := strconv.ParseInt(digits, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("amount parsing failed: %w", err)
	}
	if negative {
		value = -value
	}
	return value, nil
}

func cloneQuote(quote Quote) Quote {
	tags := make(map[string]string, len(quote.Tags))
	for key, value := range quote.Tags {
		tags[key] = value
	}
	quote.Tags = tags
	return quote
}
