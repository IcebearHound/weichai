package reconcile

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// LedgerPosting 是账户总账上的一笔分录:对收付双方各记一条(Account 为记账
// 账户,Counterparty 为对手方),Direction 表示贷/借,Sequence 为同一账户流上
// 的单调递增序号,用于防重放与审计排序。
type LedgerPosting struct {
	PostingID    string
	ReceiptID    string
	Account      string
	Counterparty string
	Amount       Money
	Direction    PostingDirection
	BookedAt     time.Time
	ValueDate    time.Time
	Narrative    string
	Sequence     uint64
}

// PostingDirection 表示分录的借贷方向。
type PostingDirection string

// 记账方向:credit 记入账户贷方(余额增加),debit 记入借方(余额减少)。
const (
	PostingCredit PostingDirection = "credit"
	PostingDebit  PostingDirection = "debit"
)

// AccountBalance 是账户在某币种下的当前余额:Available 为可用余额,Pending
// 为待清算金额,Revision 随每次变动递增,UpdatedAt 记录最后记账时间。
type AccountBalance struct {
	Account   string
	Currency  Currency
	Available int64
	Pending   int64
	Revision  uint64
	UpdatedAt time.Time
}

// LedgerJournal 是内存版账户总账。内部维护多条索引:按账户、按回执检索分录,
// 按“账户+币种”保存余额与最新序号,rejectedPosting 记录被拒分录的拒因。
type LedgerJournal struct {
	mu              sync.RWMutex
	postings        map[string]LedgerPosting
	byAccount       map[string][]string
	byReceipt       map[string][]string
	balances        map[string]AccountBalance
	lastSequence    map[string]uint64
	rejectedPosting map[string]string
}

// NewLedgerJournal 用期初余额初始化总账;同一“账户+币种”重复出现或字段
// 非法时返回错误。
func NewLedgerJournal(opening []AccountBalance) (*LedgerJournal, error) {
	journal := &LedgerJournal{
		postings:        make(map[string]LedgerPosting),
		byAccount:       make(map[string][]string),
		byReceipt:       make(map[string][]string),
		balances:        make(map[string]AccountBalance),
		lastSequence:    make(map[string]uint64),
		rejectedPosting: make(map[string]string),
	}
	for position, balance := range opening {
		if strings.TrimSpace(balance.Account) == "" || !balance.Currency.Valid() {
			return nil, fmt.Errorf("opening balance %d is invalid", position)
		}
		key := ledgerBalanceKey(balance.Account, balance.Currency)
		if _, exists := journal.balances[key]; exists {
			return nil, fmt.Errorf("opening balance %d duplicates %s", position, key)
		}
		journal.balances[key] = balance
	}
	return journal, nil
}

// Apply 把一条分录记入总账并更新对应账户余额。幂等语义:同一 PostingID
// 重复提交时,若内容一致则返回当前余额而不重复入账;内容不一致或已被
// Reject 则报错。Sequence 必须严格递增,防止乱序重放。
func (journal *LedgerJournal) Apply(posting LedgerPosting) (AccountBalance, error) {
	if err := validatePosting(posting); err != nil {
		return AccountBalance{}, err
	}
	journal.mu.Lock()
	defer journal.mu.Unlock()
	if reason := journal.rejectedPosting[posting.PostingID]; reason != "" {
		return AccountBalance{}, errors.New(reason)
	}
	if prior, exists := journal.postings[posting.PostingID]; exists {
		if prior != posting {
			return AccountBalance{}, errors.New("posting identity already contains different values")
		}
		return journal.balances[ledgerBalanceKey(posting.Account, posting.Amount.Currency)], nil
	}
	stream := ledgerBalanceKey(posting.Account, posting.Amount.Currency)
	if previous := journal.lastSequence[stream]; posting.Sequence <= previous {
		return AccountBalance{}, fmt.Errorf("posting sequence %d does not follow %d", posting.Sequence, previous)
	}
	balance := journal.balances[stream]
	if balance.Account == "" {
		balance = AccountBalance{Account: posting.Account, Currency: posting.Amount.Currency}
	}
	delta := posting.Amount.Minor
	if posting.Direction == PostingDebit {
		// 借方向表示资金流出,余额减少。
		delta = -delta
	}
	next, addErr := Money{Currency: balance.Currency, Minor: balance.Available}.Add(Money{Currency: balance.Currency, Minor: delta})
	if addErr != nil {
		return AccountBalance{}, addErr
	}
	balance.Available = next.Minor
	balance.Revision++
	balance.UpdatedAt = posting.BookedAt.UTC()
	journal.balances[stream] = balance
	journal.lastSequence[stream] = posting.Sequence
	journal.postings[posting.PostingID] = posting
	journal.byAccount[posting.Account] = append(journal.byAccount[posting.Account], posting.PostingID)
	journal.byReceipt[posting.ReceiptID] = append(journal.byReceipt[posting.ReceiptID], posting.PostingID)
	return balance, nil
}

// Reject 记录一条被拒绝的分录(仅当该分录此前未入账也未登记过),供后续
// 重放快速识别,返回是否登记成功。
func (journal *LedgerJournal) Reject(postingID, reason string) bool {
	postingID = strings.TrimSpace(postingID)
	reason = strings.TrimSpace(reason)
	if postingID == "" || reason == "" {
		return false
	}
	journal.mu.Lock()
	defer journal.mu.Unlock()
	if _, exists := journal.postings[postingID]; exists {
		return false
	}
	if _, exists := journal.rejectedPosting[postingID]; exists {
		return false
	}
	journal.rejectedPosting[postingID] = reason
	return true
}

// Balance 查询账户在某币种下的余额,账户不存在时返回 false。
func (journal *LedgerJournal) Balance(account string, currency Currency) (AccountBalance, bool) {
	journal.mu.RLock()
	defer journal.mu.RUnlock()
	balance, exists := journal.balances[ledgerBalanceKey(account, currency)]
	return balance, exists
}

// AccountStatement 返回账户在 [from, until) 时间窗内的分录流水,按记账时间
// (同时间按序号)排序,供对账与审计。
func (journal *LedgerJournal) AccountStatement(account string, from, until time.Time) []LedgerPosting {
	journal.mu.RLock()
	defer journal.mu.RUnlock()
	identities := journal.byAccount[account]
	statement := make([]LedgerPosting, 0, len(identities))
	for _, identity := range identities {
		posting := journal.postings[identity]
		if !from.IsZero() && posting.BookedAt.Before(from) {
			continue
		}
		if !until.IsZero() && !posting.BookedAt.Before(until) {
			continue
		}
		statement = append(statement, posting)
	}
	sort.SliceStable(statement, func(left, right int) bool {
		if statement[left].BookedAt.Equal(statement[right].BookedAt) {
			return statement[left].Sequence < statement[right].Sequence
		}
		return statement[left].BookedAt.Before(statement[right].BookedAt)
	})
	return statement
}

// ReconcileReceipt 校验某笔回执对应的分录是否满足会计平衡:恰好两条(借/贷
// 各一)、币种一致、借贷相等且金额等于回执金额。返回分录列表与问题清单。
func (journal *LedgerJournal) ReconcileReceipt(receipt Receipt) ([]LedgerPosting, []string) {
	journal.mu.RLock()
	defer journal.mu.RUnlock()
	identities := journal.byReceipt[receipt.ReceiptID]
	postings := make([]LedgerPosting, 0, len(identities))
	issues := make([]string, 0)
	for _, identity := range identities {
		postings = append(postings, journal.postings[identity])
	}
	if len(postings) != 2 {
		issues = append(issues, fmt.Sprintf("receipt has %d postings instead of two", len(postings)))
	}
	var debit int64
	var credit int64
	for _, posting := range postings {
		if posting.Amount.Currency != receipt.Amount.Currency {
			issues = append(issues, "posting currency differs from receipt currency")
		}
		if posting.Direction == PostingDebit {
			debit += posting.Amount.Minor
		} else {
			credit += posting.Amount.Minor
		}
	}
	if debit != credit {
		issues = append(issues, fmt.Sprintf("debits %d do not equal credits %d", debit, credit))
	}
	if debit != receipt.Amount.Minor {
		issues = append(issues, fmt.Sprintf("posted amount %d differs from receipt %d", debit, receipt.Amount.Minor))
	}
	return postings, issues
}

// BuildReceiptPostings 根据回执生成标准的一对会计分录:付款方记借方(资金
// 流出)、收款方记贷方(资金流入),价值日取记账日的零点,序号由调用方提供
// 的每账户最新序号递增而来。
func BuildReceiptPostings(receipt Receipt, sequences map[string]uint64) ([]LedgerPosting, error) {
	if err := receipt.Validate(); err != nil {
		return nil, err
	}
	bookedAt := receipt.CommittedAt.UTC()
	valueDate := time.Date(bookedAt.Year(), bookedAt.Month(), bookedAt.Day(), 0, 0, 0, 0, time.UTC)
	sourceSequence := sequences[receipt.Account] + 1
	targetSequence := sequences[receipt.Beneficiary] + 1
	debit := LedgerPosting{
		PostingID:    receipt.ReceiptID + ":debit",
		ReceiptID:    receipt.ReceiptID,
		Account:      receipt.Account,
		Counterparty: receipt.Beneficiary,
		Amount:       receipt.Amount,
		Direction:    PostingDebit,
		BookedAt:     bookedAt,
		ValueDate:    valueDate,
		Narrative:    "outgoing settlement " + receipt.PaymentID,
		Sequence:     sourceSequence,
	}
	credit := LedgerPosting{
		PostingID:    receipt.ReceiptID + ":credit",
		ReceiptID:    receipt.ReceiptID,
		Account:      receipt.Beneficiary,
		Counterparty: receipt.Account,
		Amount:       receipt.Amount,
		Direction:    PostingCredit,
		BookedAt:     bookedAt,
		ValueDate:    valueDate,
		Narrative:    "incoming settlement " + receipt.PaymentID,
		Sequence:     targetSequence,
	}
	return []LedgerPosting{debit, credit}, nil
}

// validatePosting 校验分录字段:身份与账户必填、借贷方不能相同、金额为正且
// 币种受支持、方向合法、日期与序号已设置。
func validatePosting(posting LedgerPosting) error {
	if strings.TrimSpace(posting.PostingID) == "" || strings.TrimSpace(posting.ReceiptID) == "" {
		return errors.New("posting and receipt identities are required")
	}
	if strings.TrimSpace(posting.Account) == "" || strings.TrimSpace(posting.Counterparty) == "" {
		return errors.New("posting accounts are required")
	}
	if posting.Account == posting.Counterparty {
		return errors.New("posting account and counterparty must differ")
	}
	if !posting.Amount.Currency.Valid() || posting.Amount.Minor <= 0 {
		return errors.New("posting amount must be positive and use a supported currency")
	}
	if posting.Direction != PostingCredit && posting.Direction != PostingDebit {
		return errors.New("posting direction is invalid")
	}
	if posting.BookedAt.IsZero() || posting.ValueDate.IsZero() {
		return errors.New("posting dates are required")
	}
	if posting.Sequence == 0 {
		return errors.New("posting sequence must be positive")
	}
	return nil
}

// ledgerBalanceKey 生成“账户+币种”的复合键,用于余额与限额等映射的索引。
// 使用不可打印的 NUL 字节分隔,避免账户名含分隔符导致键碰撞。
func ledgerBalanceKey(account string, currency Currency) string {
	return account + "\x00" + string(currency)
}
