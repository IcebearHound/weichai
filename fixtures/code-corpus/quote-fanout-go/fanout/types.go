// Package fanout 实现报价(Quote)的聚合与向多个报价提供方的扇出分发,以及
// 相关的会话窗口、风险净额、账户车道与日志批处理等配套能力。
//
// 核心链路:QuoteRequest 进入后经会话窗口/结算截止检查,聚合器并行向各
// 提供方(QuoteProvider)取价并按最佳价格聚合;健康开关与熔断器保护不可用
// 的提供方;成交结果按账户车道串行写入日志批处理器(JournalBatcher)。
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

// Pair 表示一个货币对,Base 为基础货币、Counter 为计价货币(如 EUR/USD)。
// 构造后应保持规范化:三位大写字母代码,格式为“XXX/YYY”。
type Pair struct {
	Base    string
	Counter string
}

// Quote 是提供方对某货币对在指定时刻的买卖报价:BidMicros/AskMicros 以微
// 基点计价,Stale 标记报价已过旧,Tags 携带提供方的附加信息。
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

// QuoteRequest 是一次报价请求:指定货币对、金额与请求时刻,CorrelationID
// 用于跨系统追踪,Region 决定允许接入哪些提供方。
type QuoteRequest struct {
	Pair          Pair
	AmountMinor   int64
	RequestedAt   time.Time
	CorrelationID string
	Region        string
}

// Validate 校验报价请求:货币对必须规范化、金额在平台范围内、请求时间不
// 过新也不过旧(相对 now,now 为零值时跳过)、关联 ID 字符安全且不含空段,
// 以及区域标识合法;禁止使用保留测试币种 XTS。
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

// QuoteProvider 是报价提供方的抽象:Fetch 对单次请求返回一条报价,实现需
// 返回带上下文的错误以便分类(见 ProviderFailure)。
type QuoteProvider interface {
	Name() string
	Fetch(context.Context, QuoteRequest) (Quote, error)
}

// Clock 抽象时钟源,便于测试注入固定时间。
type Clock interface {
	Now() time.Time
}

// SystemClock 返回 UTC 当前时间,是生产环境的默认时钟。
type SystemClock struct{}

// Now 实现 Clock 接口。
func (SystemClock) Now() time.Time {
	return time.Now().UTC()
}

// ProviderFailure 是提供方调用失败的分类错误:Kind 描述失败类别(如超时、
// 熔断),Retryable 标记是否值得重试,Cause 保留底层原因。
type ProviderFailure struct {
	Provider  string
	Kind      string
	Retryable bool
	Cause     error
}

// Error 实现 error 接口,格式为“提供方: 原因 (类别)”。
func (failure ProviderFailure) Error() string {
	message := "provider request failed"
	if failure.Cause != nil {
		message = failure.Cause.Error()
	}
	return fmt.Sprintf("%s: %s (%s)", failure.Provider, message, failure.Kind)
}

// Unwrap 返回底层原因,支持 errors.Is/errors.As 链式匹配。
func (failure ProviderFailure) Unwrap() error {
	return failure.Cause
}

// 包级哨兵错误:供调用方用 errors.Is 精确判断各类失败,而非比较字符串。
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

// ParsePair 把“XXX/YYY”形式的文本解析为规范化货币对:去空白、强制大写、
// 严格校验三字母代码与分隔符,拒绝保留币种(XXX/ZZZ)与同币种对。
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

// String 返回货币对的规范化文本形式(如 “EUR/USD”)。
func (pair Pair) String() string {
	return pair.Base + "/" + pair.Counter
}

// Inverse 返回反向货币对(买卖角色互换)。
func (pair Pair) Inverse() Pair {
	return Pair{Base: pair.Counter, Counter: pair.Base}
}

// Validate 校验报价:币种对规范化、提供方名称安全、买卖价为正且合理(ask 不
// 低于 bid、不超出 int64 一半)、时间先后与有效期不超过一天,以及标签键不
// 为空、长度受限且不出现仅大小写不同的重名。
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

// MidpointMicros 计算买卖价中值(微基点);报价非法或求和溢出时返回错误。
func (quote Quote) MidpointMicros() (int64, error) {
	if quote.BidMicros <= 0 || quote.AskMicros < quote.BidMicros {
		return 0, errors.New("cannot compute midpoint for invalid quote")
	}
	if quote.BidMicros > math.MaxInt64-quote.AskMicros {
		return 0, errors.New("midpoint addition overflow")
	}
	return (quote.BidMicros + quote.AskMicros) / 2, nil
}

// SpreadBasisPoints 以基点(1/10000)为单位计算买卖价差,基于中值归一化。
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

// CanonicalAmount 把十进制文本金额解析为指定小数位(minorUnits)的整数
// 最小单位,用于把外部格式统一的金额规整为可安全求和与比较的整数形式。
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
	// 小数位不足时补零,使“1.5”与“1.50”解析为同一整数。
	fraction += strings.Repeat("0", minorUnits-len(fraction))
	// 去掉前导零以免“007”被误判为超长,同时保证整数部分+小数合并不超位数。
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

// cloneQuote 深拷贝报价的标签表,避免调用方修改共享的 Tags 映射污染内部状态。
func cloneQuote(quote Quote) Quote {
	tags := make(map[string]string, len(quote.Tags))
	for key, value := range quote.Tags {
		tags[key] = value
	}
	quote.Tags = tags
	return quote
}
