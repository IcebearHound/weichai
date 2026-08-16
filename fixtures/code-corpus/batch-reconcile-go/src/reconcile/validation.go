package reconcile

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

// ValidationContext 描述一次校验所需的业务规则快照:允许币种、受理区域前缀、
// 黑名单受益人、按币种金额上限、属性白名单、引用格式与时间窗限制等。
// 时间为零值时表示不启用对应的校验。
type ValidationContext struct {
	Now                  time.Time
	AllowedCurrencies    map[Currency]bool
	AccountPrefixes      []string
	BlockedBeneficiaries map[string]string
	MaximumByCurrency    map[Currency]int64
	AttributeAllowList   map[string]bool
	ReferencePattern     *regexp.Regexp
	MaximumFutureSkew    time.Duration
	MaximumPastAge       time.Duration
}

// PaymentValidator 持有校验上下文,对支付/批次执行规则检查并输出结构化问题。
type PaymentValidator struct {
	context ValidationContext
}

// NewPaymentValidator 构造校验器。上下文中的 map/slice 会被拷贝(防御性复制),
// 防止调用方事后修改规则集合影响校验器行为,同时保证校验器可安全并发使用。
func NewPaymentValidator(context ValidationContext) *PaymentValidator {
	copyContext := context
	copyContext.AllowedCurrencies = cloneCurrencyFlags(context.AllowedCurrencies)
	copyContext.MaximumByCurrency = cloneCurrencyLimits(context.MaximumByCurrency)
	copyContext.AttributeAllowList = cloneStringFlags(context.AttributeAllowList)
	copyContext.BlockedBeneficiaries = cloneStrings(context.BlockedBeneficiaries)
	copyContext.AccountPrefixes = append([]string(nil), context.AccountPrefixes...)
	sort.Strings(copyContext.AccountPrefixes)
	return &PaymentValidator{context: copyContext}
}

// Inspect 对单笔支付执行全部规则检查,返回按位置、字段、错误码排序的问题列表。
// 先做领域基础校验,再逐项检查窗口级规则:币种可用性、金额上限、账户区域、
// 受益人黑名单、引用格式、请求时间范围与属性白名单。
func (validator *PaymentValidator) Inspect(payment Payment, position int) []ValidationIssue {
	issues := make([]ValidationIssue, 0, 8)
	if err := payment.Validate(); err != nil {
		issues = append(issues, ValidationIssue{
			Position: position,
			Field:    "payment",
			Code:     "domain.invalid",
			Message:  err.Error(),
		})
	}
	if len(validator.context.AllowedCurrencies) > 0 && !validator.context.AllowedCurrencies[payment.Amount.Currency] {
		issues = append(issues, ValidationIssue{
			Position: position,
			Field:    "amount.currency",
			Code:     "currency.disallowed",
			Message:  fmt.Sprintf("currency %s is disabled for this settlement window", payment.Amount.Currency),
		})
	}
	if maximum := validator.context.MaximumByCurrency[payment.Amount.Currency]; maximum > 0 && payment.Amount.Minor > maximum {
		issues = append(issues, ValidationIssue{
			Position: position,
			Field:    "amount.minor",
			Code:     "amount.limit",
			Message:  fmt.Sprintf("amount %d exceeds limit %d", payment.Amount.Minor, maximum),
		})
	}
	if len(validator.context.AccountPrefixes) > 0 && !matchesAnyPrefix(payment.Account, validator.context.AccountPrefixes) {
		issues = append(issues, ValidationIssue{
			Position: position,
			Field:    "account",
			Code:     "account.region",
			Message:  "source account does not belong to an admitted region",
		})
	}
	if reason, blocked := validator.context.BlockedBeneficiaries[payment.Beneficiary]; blocked {
		issues = append(issues, ValidationIssue{
			Position: position,
			Field:    "beneficiary",
			Code:     "beneficiary.blocked",
			Message:  reason,
		})
	}
	if pattern := validator.context.ReferencePattern; pattern != nil && payment.Reference != "" && !pattern.MatchString(payment.Reference) {
		issues = append(issues, ValidationIssue{
			Position: position,
			Field:    "reference",
			Code:     "reference.format",
			Message:  "reference does not match the clearing convention",
		})
	}
	if !validator.context.Now.IsZero() && !payment.RequestedAt.IsZero() {
		if validator.context.MaximumFutureSkew > 0 && payment.RequestedAt.After(validator.context.Now.Add(validator.context.MaximumFutureSkew)) {
			issues = append(issues, ValidationIssue{
				Position: position,
				Field:    "requestedAt",
				Code:     "time.future",
				Message:  "payment timestamp is too far in the future",
			})
		}
		if validator.context.MaximumPastAge > 0 && payment.RequestedAt.Before(validator.context.Now.Add(-validator.context.MaximumPastAge)) {
			issues = append(issues, ValidationIssue{
				Position: position,
				Field:    "requestedAt",
				Code:     "time.expired",
				Message:  "payment timestamp is outside the admission horizon",
			})
		}
	}
	for key := range payment.Attributes {
		if len(validator.context.AttributeAllowList) > 0 && !validator.context.AttributeAllowList[key] {
			issues = append(issues, ValidationIssue{
				Position: position,
				Field:    "attributes." + key,
				Code:     "attribute.unknown",
				Message:  "attribute is not accepted by the clearing profile",
			})
		}
	}
	sort.SliceStable(issues, func(left, right int) bool {
		if issues[left].Position != issues[right].Position {
			return issues[left].Position < issues[right].Position
		}
		if issues[left].Field != issues[right].Field {
			return issues[left].Field < issues[right].Field
		}
		return issues[left].Code < issues[right].Code
	})
	return issues
}

// InspectBatch 对整批请求执行校验:批次级规则(幂等键长度、尝试次数、截止
// 时间)加上每笔支付的 Inspect,并检测批内支付身份重复。
func (validator *PaymentValidator) InspectBatch(request CommitRequest) []ValidationIssue {
	issues := make([]ValidationIssue, 0)
	if key := strings.TrimSpace(request.IdempotencyKey); len(key) < 8 || len(key) > 128 {
		issues = append(issues, ValidationIssue{
			Position: -1,
			Field:    "idempotencyKey",
			Code:     "batch.key",
			Message:  "idempotency key must contain between 8 and 128 characters",
		})
	}
	if request.MaximumAttempts < 1 || request.MaximumAttempts > 12 {
		issues = append(issues, ValidationIssue{
			Position: -1,
			Field:    "maximumAttempts",
			Code:     "batch.attempts",
			Message:  "attempt limit must be between one and twelve",
		})
	}
	if !request.Deadline.IsZero() && !request.Deadline.After(request.RequestedAt) {
		issues = append(issues, ValidationIssue{
			Position: -1,
			Field:    "deadline",
			Code:     "batch.deadline",
			Message:  "deadline must follow the batch request time",
		})
	}
	seen := make(map[string]int, len(request.Payments))
	for position, payment := range request.Payments {
		issues = append(issues, validator.Inspect(payment, position)...)
		if previous, exists := seen[payment.Identity]; exists {
			issues = append(issues, ValidationIssue{
				Position: position,
				Field:    "identity",
				Code:     "payment.duplicate",
				Message:  fmt.Sprintf("payment identity also occurs at position %d", previous),
			})
		} else {
			seen[payment.Identity] = position
		}
	}
	return issues
}

// GroupIssuesByCode 把问题按错误码分组(组内按位置排序),便于按类别汇总告警。
func GroupIssuesByCode(issues []ValidationIssue) map[string][]ValidationIssue {
	result := make(map[string][]ValidationIssue)
	for _, issue := range issues {
		result[issue.Code] = append(result[issue.Code], issue)
	}
	for code := range result {
		sort.SliceStable(result[code], func(left, right int) bool {
			return result[code][left].Position < result[code][right].Position
		})
	}
	return result
}

// matchesAnyPrefix 报告值是否以任一前缀开头(账户区域判断)。
func matchesAnyPrefix(value string, prefixes []string) bool {
	for _, prefix := range prefixes {
		if strings.HasPrefix(value, prefix) {
			return true
		}
	}
	return false
}

// cloneCurrencyFlags 拷贝币种->布尔映射(防御性复制,下同)。
func cloneCurrencyFlags(source map[Currency]bool) map[Currency]bool {
	result := make(map[Currency]bool, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

// cloneCurrencyLimits 拷贝币种->金额上限映射。
func cloneCurrencyLimits(source map[Currency]int64) map[Currency]int64 {
	result := make(map[Currency]int64, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

// cloneStringFlags 拷贝字符串->布尔映射(属性白名单)。
func cloneStringFlags(source map[string]bool) map[string]bool {
	result := make(map[string]bool, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

// cloneStrings 拷贝字符串->字符串映射(受益人黑名单及其拒因)。
func cloneStrings(source map[string]string) map[string]string {
	result := make(map[string]string, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}
