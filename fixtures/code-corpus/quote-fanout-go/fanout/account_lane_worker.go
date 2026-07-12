package fanout

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

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

type AccountHandler func(context.Context, AccountMessage) error

type AccountLanePolicy struct {
	MaximumDelivery int
	MaximumPayload  int
	DedupeFor       time.Duration
	IdleLaneFor     time.Duration
}

type accountLane struct {
	mu           sync.Mutex
	lastSequence uint64
	hasSequence  bool
	lastUsed     time.Time
	running      bool
	failures     uint64
}

type processedMessage struct {
	accountID string
	sequence  uint64
	when      time.Time
}

type AccountLaneView struct {
	AccountID    string
	LastSequence uint64
	HasSequence  bool
	LastUsed     time.Time
	Running      bool
	Failures     uint64
}

type AccountLaneWorker struct {
	mu        sync.Mutex
	clock     Clock
	policy    AccountLanePolicy
	lanes     map[string]*accountLane
	processed map[string]processedMessage
}

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
			reason := fmt.Errorf("account sequence gap: have %d, received %d", lane.lastSequence, message.Sequence)
			lane.failures++
			if err := message.RejectDelivery(ctx, reason); err != nil {
				return errors.Join(reason, fmt.Errorf("gap rejection failed: %w", err))
			}
			return reason
		}
	} else if message.Sequence != 0 {
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
