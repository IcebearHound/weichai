// Package reconcile 实现一个带幂等语义的批量支付提交与对账引擎。
//
// 核心流程:客户端携带幂等键(IdempotencyKey)提交一批支付(CommitRequest),
// 引擎逐笔执行提交(可能伴随多次重试),为成功支付的每笔生成不可篡改的回执
// (Receipt),最终汇总为批次的执行结果(BatchSummary)。幂等键配合批次指纹
// (Fingerprint)用于检测重复提交与键冲突;回执可编码为带 CRC 校验和的二进制
// 帧(ReceiptFrame)以便持久化与跨系统传输。
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

// Currency 表示支付金额所使用的货币代码,采用 ISO 4217 三位字母代码。
type Currency string

// 引擎支持的货币白名单。新增币种必须先在此登记,否则 Currency.Valid 将拒绝。
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

// Money 以“货币 + 最小单位整数”表示金额,避免浮点误差。Minor 为最小货币
// 单位(分)的数量,可正可负。
type Money struct {
	Currency Currency
	Minor    int64
}

// NewMoney 构造一个 Money;币种不在白名单内时返回错误,金额本身不做正负限制。
func NewMoney(currency Currency, minor int64) (Money, error) {
	if !currency.Valid() {
		return Money{}, fmt.Errorf("unsupported currency %q", currency)
	}
	return Money{Currency: currency, Minor: minor}, nil
}

// Valid 报告币种是否在引擎支持的白名单内。
func (currency Currency) Valid() bool {
	switch currency {
	case CurrencyAUD, CurrencyCAD, CurrencyCHF, CurrencyCNY,
		CurrencyEUR, CurrencyGBP, CurrencyJPY, CurrencyUSD:
		return true
	default:
		return false
	}
}

// Add 将两笔同币种金额相加并返回新的 Money。币种不一致时报错;由于先做
// 溢出预判(以 MaxInt64/MinInt64 为界)再求和,即使两数同号也不会溢出。
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

// String 将金额格式化为“币种 + 整数部分 + 两位小数”的展示形式,负数带减号。
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

// Payment 描述一笔待提交的支付:从 Account 付款给 Beneficiary。Attributes
// 携带业务自定义属性;Priority 为 0~9 的优先级,值越大优先级越高;整个批次
// 的支付应在同一路由(ExpectedRoute)上执行以保证可重试性。
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

// Validate 校验支付字段的合法性:必填项、金额为正、币种受支持、引用长度、
// 优先级区间以及属性条数与键值长度等。返回第一个不满足条件的错误。
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

// Fingerprint 对支付的所有业务字段做规范化哈希,得到 64 位十六进制摘要。
// 属性键先排序再参与哈希,使同一支付无论属性遍历顺序如何都得到相同指纹,
// 从而可用于内容寻址与重复检测。
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

// CommitRequest 是一次批量提交的完整请求。IdempotencyKey 是调用方生成的
// 幂等键,重试时携带同一把键即可安全重复提交;MaximumAttempts 限制引擎对
// 整批的尝试次数;Deadline 为整体完成时限,零值表示不设限。
type CommitRequest struct {
	IdempotencyKey  string
	Payments        []Payment
	MaximumAttempts int
	RequestedAt     time.Time
	Deadline        time.Time
}

// Validate 校验批量请求:幂等键长度、批内支付数量上下限、最大尝试次数区间,
// 以及逐笔支付本身的合法性,并保证批内支付身份(Identity)不重复。
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

// Fingerprint 对批次请求的关键字段(幂等键、时间、尝试次数)与逐笔支付的
// 指纹级联求哈希,用于与已提交批次做内容比对、识别幂等冲突。
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

// Receipt 是单笔支付成功提交后的回执,可作为支付已入账的凭证。EvidenceDigest
// 是外部渠道(如银行)返回的 64 位十六进制证据摘要,用于审计对账。
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

// Validate 校验回执的完整性:引用字段非空、尝试次数为正、提交时间已设置,
// 且证据摘要必须是 64 位十六进制字符串。
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

// TransferResult 是单笔支付在渠道侧的执行结果,供上层决定是否成功入账。
// ProviderToken 为渠道返回的外部凭证;Metadata 携带渠道的附加信息。
type TransferResult struct {
	ProviderToken string
	Route         string
	CommittedAt   time.Time
	Metadata      map[string]string
}

// BatchEntry 记录批次中一笔支付的最终结果:成功时 Receipt 非空,失败时
// Failure 非空且 Attempts 记录实际尝试次数。Position 为该笔在批次中的下标。
type BatchEntry struct {
	Position  int
	PaymentID string
	Receipt   *Receipt
	Attempts  int
	Failure   *CommitFailure
}

// Successful 报告该笔支付是否已成功入账(收到回执且无失败信息)。
func (entry BatchEntry) Successful() bool {
	return entry.Receipt != nil && entry.Failure == nil
}

// FailureKind 对失败原因分类,供上层按类别统计与决策(如是否可重试)。
type FailureKind string

// 各失败类别:被取消、键冲突、校验失败、永久失败、重试预算耗尽、超时与
// 瞬时故障。后三类通常可由引擎重试消化。
const (
	FailureCancelled   FailureKind = "cancelled"
	FailureConflict    FailureKind = "conflict"
	FailureInvalid     FailureKind = "invalid"
	FailurePermanent   FailureKind = "permanent"
	FailureRetryBudget FailureKind = "retry-budget"
	FailureTimeout     FailureKind = "timeout"
	FailureTransient   FailureKind = "transient"
)

// CommitFailure 描述一笔支付失败的原因。Retryable 标记该类失败是否值得
// 在剩余预算内重试;Cause 保留底层错误的引用以便 Unwrap 链式追踪。
type CommitFailure struct {
	Kind      FailureKind
	Message   string
	Retryable bool
	Cause     error
}

// Error 实现 error 接口,格式为“类别: 描述[: 底层原因]”。
func (failure *CommitFailure) Error() string {
	if failure == nil {
		return ""
	}
	if failure.Cause == nil {
		return string(failure.Kind) + ": " + failure.Message
	}
	return string(failure.Kind) + ": " + failure.Message + ": " + failure.Cause.Error()
}

// Unwrap 返回底层原因,支持 errors.Is/errors.As 沿错误链查找。
func (failure *CommitFailure) Unwrap() error {
	if failure == nil {
		return nil
	}
	return failure.Cause
}

// BatchSummary 汇总一次批次的执行结果:成功/失败笔数、总尝试次数、按币种
// 累计的入账金额、失败类别分布以及全部回执 ID,便于对账与审计。
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

// SummarizeBatch 根据批次的逐笔结果聚合出 BatchSummary:累计尝试次数、
// 成功/失败计数,并按币种累加成功入账金额、统计失败类别。
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
			// 首次遇到该币种时,map 返回零值,需先补上币种字段再累加金额。
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

// ValidationIssue 描述校验过程中发现的单个问题,Position 为批内支付下标,
// Code 为可编程处理的稳定错误码,Message 面向人阅读。
type ValidationIssue struct {
	Position int
	Field    string
	Code     string
	Message  string
}

// BatchConflictError 表示幂等键已被其他批次占用,且两次请求的指纹不一致。
// 调用方应视为不可重试的业务冲突,而非可以安全重放的瞬态故障。
type BatchConflictError struct {
	Key                 string
	ExistingFingerprint string
	IncomingFingerprint string
}

// Error 实现 error 接口,仅暴露幂等键,不泄露任何一批的内容细节。
func (conflict *BatchConflictError) Error() string {
	return fmt.Sprintf("idempotency key %q already names a different batch", conflict.Key)
}

// writeFingerprintPart 以“长度:值|”的定界格式写入指纹的一个字段。长度前缀
// 保证字段边界无歧义——例如 "ab"+"c" 与 "a"+"bc" 不会碰撞为同一指纹。
func writeFingerprintPart(target interface{ Write([]byte) (int, error) }, value string) {
	length := strconv.Itoa(len(value))
	_, _ = target.Write([]byte(length))
	_, _ = target.Write([]byte{':'})
	_, _ = target.Write([]byte(value))
	_, _ = target.Write([]byte{'|'})
}
