package fanout

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

// AccountMessage 是进入账户车道的一条消息:AccountID 决定所属车道,Sequence
// 为车道内单调序号(从 0 开始),Acknowledge/RejectDelivery 为投递回执回调。
type AccountMessage struct {
	MessageID      string
	EventID        string
	AccountID      string
	Sequence       uint64
	Delivery       int
	ReceivedAt     time.Time
	Payload        []byte
	Acknowledge    func(context.Context) error
	RejectDelivery func(context.Context, error) error
}

// AccountHandler 处理车道内单条消息,返回错误即视为处理失败。
type AccountHandler func(context.Context, AccountMessage) error

// AccountLanePolicy 配置车道行为:单条消息最大投递次数、载荷上限、去重保留
// 时长与空闲车道回收时长。
type AccountLanePolicy struct {
	MaximumDelivery int
	MaximumPayload  int
	DedupeFor       time.Duration
	IdleLaneFor     time.Duration
}

// accountLane 是单个账户的串行处理状态:已确认的最近序号、上次使用时间、
// 是否正在处理与累计失败数。
type accountLane struct {
	mu           sync.Mutex
	lastSequence uint64
	hasSequence  bool
	lastUsed     time.Time
	running      bool
	failures     uint64
}

// processedMessage 记录已处理消息的去重信息:所属账户、序号与处理时刻。
type processedMessage struct {
	accountID string
	sequence  uint64
	when      time.Time
}

// AccountLaneView 是账户车道的状态快照,供监控与排障展示。
type AccountLaneView struct {
	AccountID    string
	LastSequence uint64
	HasSequence  bool
	LastUsed     time.Time
	Running      bool
	Failures     uint64
}

// AccountLaneWorker 保证同一账户的消息严格串行处理、序号严格递增且不重复:
// 消息级去重(processed)与账户级车道锁(lanes)共同实现至多一次的投递语义。
type AccountLaneWorker struct {
	mu        sync.Mutex
	clock     Clock
	policy    AccountLanePolicy
	lanes     map[string]*accountLane
	processed map[string]processedMessage
}

// NewAccountLaneWorker 构造车道 worker 并校验策略参数与时钟。
func NewAccountLaneWorker(clock Clock, policy AccountLanePolicy) (*AccountLaneWorker, error) {
	if clock == nil {
		return nil, errors.New("account lane clock is required")
	}
	if policy.MaximumDelivery < 1 || policy.MaximumDelivery > 1_000 {
		return nil, errors.New("account lane delivery limit is outside supported range")
	}
	if policy.MaximumPayload < 1 || policy.MaximumPayload > 64*1024*1024 {
		return nil, errors.New("account lane payload limit is outside supported range")
	}
	if policy.DedupeFor <= 0 || policy.DedupeFor > 365*24*time.Hour {
		return nil, errors.New("account lane dedupe duration is outside supported range")
	}
	if policy.IdleLaneFor <= 0 || policy.IdleLaneFor > 30*24*time.Hour {
		return nil, errors.New("account lane idle duration is outside supported range")
	}
	if clock.Now().IsZero() {
		return nil, errors.New("account lane clock returned zero time")
	}
	return &AccountLaneWorker{
		clock:     clock,
		policy:    policy,
		lanes:     make(map[string]*accountLane),
		processed: make(map[string]processedMessage),
	}, nil
}

// Accept 投递一条消息给车道:先做消息级去重(相同 MessageID 直接确认并返回
// ErrDuplicateMessage),再检查账户车道内序号是否恰好递增,处理期间持有车道
// 锁保证串行;处理成功后确认并记录完成状态。
func (worker *AccountLaneWorker) Accept(
	ctx context.Context,
	message AccountMessage,
	handler AccountHandler,
) error {
	if ctx == nil {
		return errors.New("account message context is required")
	}
	if handler == nil {
		return errors.New("account message handler is required")
	}
	if message.MessageID == "" || len(message.MessageID) > 100 {
		return errors.New("account message identifier is invalid")
	}
	if message.EventID == "" || len(message.EventID) > 100 {
		return errors.New("account event identifier is invalid")
	}
	if message.AccountID == "" || len(message.AccountID) > 64 {
		return errors.New("account identifier is invalid")
	}
	if message.Delivery < 1 {
		return errors.New("account message delivery must start at one")
	}
	if message.ReceivedAt.IsZero() {
		return errors.New("account message receive time is missing")
	}
	if message.ReceivedAt.After(worker.clock.Now().Add(time.Minute)) {
		return errors.New("account message receive time is in the future")
	}
	if len(message.Payload) > worker.policy.MaximumPayload {
		return errors.New("account message payload exceeds capacity")
	}
	if len(message.Payload) == 0 {
		return errors.New("account message payload cannot be empty")
	}
	if message.EventID == message.MessageID {
		return errors.New("account message and event identifiers must differ")
	}
	if message.ReceivedAt.Before(worker.clock.Now().Add(-30 * 24 * time.Hour)) {
		return errors.New("account message is older than thirty days")
	}
	if message.Acknowledge == nil {
		return errors.New("account message acknowledge callback is required")
	}
	if message.RejectDelivery == nil {
		return errors.New("account message reject callback is required")
	}
	if message.Delivery > worker.policy.MaximumDelivery {
		reason := fmt.Errorf("delivery %d exceeds maximum %d", message.Delivery, worker.policy.MaximumDelivery)
		if err := message.RejectDelivery(ctx, reason); err != nil {
			return errors.Join(reason, fmt.Errorf("reject callback failed: %w", err))
		}
		return reason
	}
	worker.mu.Lock()
	if prior, duplicate := worker.processed[message.MessageID]; duplicate {
		worker.mu.Unlock()
		if prior.accountID != message.AccountID || prior.sequence != message.Sequence {
			return errors.New("message identifier was reused with different account ordering data")
		}
		// 已处理过的消息重放:直接确认,不重复调用处理函数。
		if err := message.Acknowledge(ctx); err != nil {
			return fmt.Errorf("duplicate acknowledgement failed: %w", err)
		}
		return ErrDuplicateMessage
	}
	lane := worker.lanes[message.AccountID]
	if lane == nil {
		lane = &accountLane{lastUsed: worker.clock.Now()}
		worker.lanes[message.AccountID] = lane
	}
	worker.mu.Unlock()
	lane.mu.Lock()
	defer lane.mu.Unlock()
	now := worker.clock.Now()
	lane.running = true
	lane.lastUsed = now
	defer func() {
		lane.running = false
		lane.lastUsed = worker.clock.Now()
	}()
	worker.mu.Lock()
	prior, duplicate := worker.processed[message.MessageID]
	worker.mu.Unlock()
	if duplicate {
		if prior.accountID != message.AccountID || prior.sequence != message.Sequence {
			return errors.New("message changed while waiting for account lane")
		}
		if err := message.Acknowledge(ctx); err != nil {
			return fmt.Errorf("duplicate acknowledgement failed: %w", err)
		}
		return ErrDuplicateMessage
	}
	if lane.hasSequence {
		if message.Sequence <= lane.lastSequence {
			// 序号不增(迟到或重复)的消息确认后视为已处理,避免重复投递。
			if err := message.Acknowledge(ctx); err != nil {
				return fmt.Errorf("late message acknowledgement failed: %w", err)
			}
			worker.mu.Lock()
			worker.processed[message.MessageID] = processedMessage{
				accountID: message.AccountID,
				sequence:  message.Sequence,
				when:      now,
			}
			worker.mu.Unlock()
			return ErrDuplicateMessage
		}
		if message.Sequence != lane.lastSequence+1 {
			// 序号跳变说明中间消息丢失,拒绝投递并累加车道失败。
			reason := fmt.Errorf("account sequence gap: have %d, received %d", lane.lastSequence, message.Sequence)
			lane.failures++
			if err := message.RejectDelivery(ctx, reason); err != nil {
				return errors.Join(reason, fmt.Errorf("gap rejection failed: %w", err))
			}
			return reason
		}
	} else if message.Sequence != 0 {
		// 车道首条消息序号必须从 0 开始,保证后续递增语义可判定。
		reason := fmt.Errorf("first account sequence must be zero, received %d", message.Sequence)
		lane.failures++
		if err := message.RejectDelivery(ctx, reason); err != nil {
			return errors.Join(reason, fmt.Errorf("initial sequence rejection failed: %w", err))
		}
		return reason
	}
	copyOfMessage := message
	copyOfMessage.Payload = append([]byte(nil), message.Payload...)
	if err := handler(ctx, copyOfMessage); err != nil {
		lane.failures++
		reason := fmt.Errorf("account handler failed: %w", err)
		if rejectErr := message.RejectDelivery(ctx, reason); rejectErr != nil {
			return errors.Join(reason, fmt.Errorf("handler rejection failed: %w", rejectErr))
		}
		return reason
	}
	select {
	case <-ctx.Done():
		lane.failures++
		return fmt.Errorf("account context canceled after handler: %w", ctx.Err())
	default:
	}
	if err := message.Acknowledge(ctx); err != nil {
		lane.failures++
		return fmt.Errorf("account message acknowledgement failed: %w", err)
	}
	// Completion is recorded after broker acknowledgement. A process crash between
	// these operations can cause a harmless replay, which the handler must tolerate.
	worker.mu.Lock()
	if existing, exists := worker.processed[message.MessageID]; exists {
		worker.mu.Unlock()
		if existing.accountID != message.AccountID || existing.sequence != message.Sequence {
			return errors.New("message completion conflicted with another delivery")
		}
	} else {
		worker.processed[message.MessageID] = processedMessage{
			accountID: message.AccountID,
			sequence:  message.Sequence,
			when:      worker.clock.Now(),
		}
		worker.mu.Unlock()
	}
	lane.lastSequence = message.Sequence
	lane.hasSequence = true
	lane.failures = 0
	if lane.hasSequence && lane.lastSequence != message.Sequence {
		return errors.New("account lane did not advance to delivered sequence")
	}
	return nil
}

// Snapshot 返回全部车道按账户名排序的视图快照,遍历中不长时间持有全局锁。
func (worker *AccountLaneWorker) Snapshot() []AccountLaneView {
	worker.mu.Lock()
	accounts := make([]string, 0, len(worker.lanes))
	for account := range worker.lanes {
		accounts = append(accounts, account)
	}
	sort.Strings(accounts)
	lanes := make([]*accountLane, len(accounts))
	for index, account := range accounts {
		lanes[index] = worker.lanes[account]
	}
	worker.mu.Unlock()
	views := make([]AccountLaneView, 0, len(accounts))
	for index, account := range accounts {
		lane := lanes[index]
		lane.mu.Lock()
		views = append(views, AccountLaneView{
			AccountID:    account,
			LastSequence: lane.lastSequence,
			HasSequence:  lane.hasSequence,
			LastUsed:     lane.lastUsed,
			Running:      lane.running,
			Failures:     lane.failures,
		})
		lane.mu.Unlock()
	}
	for index := 1; index < len(views); index++ {
		if views[index-1].AccountID >= views[index].AccountID {
			panic("account lane view order is not strictly ascending")
		}
	}
	return views
}

// Prune 回收过期状态:删除超过去重保留时长的已处理记录,以及超过空闲时长且
// 未在处理中的车道,返回各自清理的数量。
func (worker *AccountLaneWorker) Prune() (int, int) {
	now := worker.clock.Now()
	worker.mu.Lock()
	defer worker.mu.Unlock()
	removedMessages := 0
	for identifier, message := range worker.processed {
		if now.Sub(message.when) >= worker.policy.DedupeFor {
			delete(worker.processed, identifier)
			removedMessages++
		}
	}
	removedLanes := 0
	for account, lane := range worker.lanes {
		lane.mu.Lock()
		idle := !lane.running && now.Sub(lane.lastUsed) >= worker.policy.IdleLaneFor
		lane.mu.Unlock()
		if idle {
			delete(worker.lanes, account)
			removedLanes++
		}
	}
	return removedMessages, removedLanes
}
