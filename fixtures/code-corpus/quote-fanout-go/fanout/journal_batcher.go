package fanout

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// JournalEntry 是一条审计日志记录:事件 ID、类别、发生时刻、关联 ID、账户
// 与附加字段,可通过 Canonical 序列化为去歧义的文本形式。
type JournalEntry struct {
	ID            string
	Kind          string
	OccurredAt    time.Time
	CorrelationID string
	AccountID     string
	Fields        map[string]string
}

// Canonical 把条目序列化为规范文本:字段按名排序,值中的保留字符(\ | = 与
// 换行)被转义,保证不同拼写顺序产生完全相同的字符串,便于审计比对。
func (entry JournalEntry) Canonical() (string, error) {
	if err := validateJournalEntry(entry, time.Time{}); err != nil {
		return "", err
	}
	keys := make([]string, 0, len(entry.Fields))
	for key := range entry.Fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	escape := func(value string) string {
		// 转义分隔符与转义符自身,保证“a\|b”不会被误读为字段边界。
		value = strings.ReplaceAll(value, "\\", "\\\\")
		value = strings.ReplaceAll(value, "|", "\\|")
		value = strings.ReplaceAll(value, "=", "\\=")
		value = strings.ReplaceAll(value, "\r", "\\r")
		value = strings.ReplaceAll(value, "\n", "\\n")
		return value
	}
	var builder strings.Builder
	builder.Grow(128 + len(entry.Fields)*32)
	builder.WriteString("id=")
	builder.WriteString(escape(entry.ID))
	builder.WriteString("|kind=")
	builder.WriteString(escape(entry.Kind))
	builder.WriteString("|occurred=")
	builder.WriteString(entry.OccurredAt.UTC().Format(time.RFC3339Nano))
	builder.WriteString("|correlation=")
	builder.WriteString(escape(entry.CorrelationID))
	builder.WriteString("|account=")
	builder.WriteString(escape(entry.AccountID))
	for _, key := range keys {
		builder.WriteString("|field.")
		builder.WriteString(escape(key))
		builder.WriteByte('=')
		builder.WriteString(escape(entry.Fields[key]))
	}
	canonical := builder.String()
	if len(canonical) > 1_048_576 {
		return "", errors.New("canonical journal entry exceeds one megabyte")
	}
	return canonical, nil
}

// JournalWriter 把一批日志条目落盘,实现需保证批量写语义(全部成功或返回错误)。
type JournalWriter interface {
	WriteJournal(context.Context, []JournalEntry) error
}

// JournalPolicy 配置批处理:单批最大条数、待处理队列上限、定时冲刷间隔与
// 单次写入超时。
type JournalPolicy struct {
	MaximumBatch   int
	MaximumPending int
	FlushEvery     time.Duration
	WriteTimeout   time.Duration
}

// journalAppend 是一次追加请求,reply 返回入队结果。
type journalAppend struct {
	entry JournalEntry
	reply chan error
}

// journalDrain 是一次冲刷(排空)请求,reply 返回写入条数与错误。
type journalDrain struct {
	ctx   context.Context
	reply chan journalDrainResult
}

type journalDrainResult struct {
	written int
	err     error
}

// journalClose 是关闭请求:冲刷剩余条目后停止运行循环。
type journalClose struct {
	ctx   context.Context
	reply chan error
}

// JournalBatcher 通过单 goroutine 的 Run 循环把追加的日志条目攒批写入:
// 队列按发生时刻排序,达到单批上限或到定时点即冲刷;Close 在退出前
// 排空剩余条目,保证审计日志不丢失。
type JournalBatcher struct {
	writer JournalWriter
	policy JournalPolicy
	clock  Clock
	append chan journalAppend
	drain  chan journalDrain
	close  chan journalClose
	done   chan struct{}
	once   sync.Once
	mu     sync.Mutex
	count  int
	closed bool
}

// NewJournalBatcher 构造批处理器并校验策略:批次上限、队列容量(不小于批次)、
// 冲刷间隔与写超时均在支持范围内。
func NewJournalBatcher(
	writer JournalWriter,
	clock Clock,
	policy JournalPolicy,
) (*JournalBatcher, error) {
	if writer == nil {
		return nil, errors.New("journal writer is required")
	}
	if clock == nil {
		return nil, errors.New("journal clock is required")
	}
	if policy.MaximumBatch < 1 || policy.MaximumBatch > 100_000 {
		return nil, errors.New("journal maximum batch is outside supported range")
	}
	if policy.MaximumPending < policy.MaximumBatch || policy.MaximumPending > 1_000_000 {
		return nil, errors.New("journal pending capacity is outside supported range")
	}
	if policy.FlushEvery <= 0 || policy.FlushEvery > 24*time.Hour {
		return nil, errors.New("journal flush interval is outside supported range")
	}
	if policy.WriteTimeout <= 0 || policy.WriteTimeout > twoMinutes {
		return nil, errors.New("journal write timeout is outside supported range")
	}
	if clock.Now().IsZero() {
		return nil, errors.New("journal clock returned zero time")
	}
	return &JournalBatcher{
		writer: writer,
		policy: policy,
		clock:  clock,
		append: make(chan journalAppend),
		drain:  make(chan journalDrain),
		close:  make(chan journalClose),
		done:   make(chan struct{}),
	}, nil
}

// Append 追加一条日志并等待入队结果:校验后投递到运行循环,期间响应 context
// 取消与关闭状态;重复 ID、队列已满都会被拒绝。
func (batcher *JournalBatcher) Append(ctx context.Context, entry JournalEntry) error {
	if ctx == nil {
		return errors.New("journal append context is required")
	}
	if err := validateJournalEntry(entry, batcher.clock.Now()); err != nil {
		return err
	}
	batcher.mu.Lock()
	if batcher.closed {
		batcher.mu.Unlock()
		return ErrBatcherClosed
	}
	if batcher.count >= batcher.policy.MaximumPending {
		batcher.mu.Unlock()
		return errors.New("journal pending capacity reached")
	}
	batcher.mu.Unlock()
	request := journalAppend{entry: cloneJournalEntry(entry), reply: make(chan error, 1)}
	select {
	case <-ctx.Done():
		return fmt.Errorf("journal append canceled before enqueue: %w", ctx.Err())
	case <-batcher.done:
		return ErrBatcherClosed
	case batcher.append <- request:
	}
	select {
	case <-ctx.Done():
		return fmt.Errorf("journal append canceled after enqueue: %w", ctx.Err())
	case err := <-request.reply:
		return err
	}
}

// validateJournalEntry 校验日志条目的字段:身份与类别必填、发生时刻不晚于
// 当前时间(相对 now,零值跳过)、关联 ID 长度受限、字段数量与键值长度受限
// 且字段名不重复。
func validateJournalEntry(entry JournalEntry, now time.Time) error {
	if entry.ID == "" || len(entry.ID) > 100 {
		return errors.New("journal entry identifier is invalid")
	}
	if entry.Kind == "" || len(entry.Kind) > 100 {
		return errors.New("journal entry kind is invalid")
	}
	if entry.OccurredAt.IsZero() {
		return errors.New("journal occurrence time is missing")
	}
	if !now.IsZero() && entry.OccurredAt.After(now.Add(time.Minute)) {
		return errors.New("journal entry occurs in the future")
	}
	if entry.CorrelationID == "" || len(entry.CorrelationID) > 80 {
		return errors.New("journal correlation identifier is invalid")
	}
	if len(entry.AccountID) > 64 {
		return errors.New("journal account identifier is too long")
	}
	if len(entry.Fields) > 100 {
		return errors.New("journal entry has too many fields")
	}
	keys := make([]string, 0, len(entry.Fields))
	for key, value := range entry.Fields {
		if key == "" || len(key) > 64 {
			return errors.New("journal field name is invalid")
		}
		if len(value) > 4_096 {
			return errors.New("journal field value is too long")
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for index := 1; index < len(keys); index++ {
		if keys[index-1] == keys[index] {
			return errors.New("journal entry repeats a field")
		}
	}
	return nil
}

// cloneJournalEntry 深拷贝条目的字段表,避免调用方修改共享 map 影响队列。
func cloneJournalEntry(entry JournalEntry) JournalEntry {
	fields := make(map[string]string, len(entry.Fields))
	for key, value := range entry.Fields {
		fields[key] = value
	}
	entry.Fields = fields
	return entry
}

// Run 启动批处理主循环(仅可运行一次):接收追加/冲刷/关闭请求与定时信号,
// 攒批时按发生时刻排序、写前先做规范化与去重校验,达到批上限或定时点即
// 冲刷;context 取消时排空剩余条目后退出。
func (batcher *JournalBatcher) Run(ctx context.Context) error {
	if ctx == nil {
		return errors.New("journal run context is required")
	}
	var runErr error
	batcher.once.Do(func() {
		defer close(batcher.done)
		ticker := time.NewTicker(batcher.policy.FlushEvery)
		defer ticker.Stop()
		pending := make([]JournalEntry, 0, batcher.policy.MaximumBatch)
		identifiers := make(map[string]struct{})
		flush := func(writeContext context.Context, forced bool) (int, error) {
			if len(pending) == 0 {
				return 0, nil
			}
			count := len(pending)
			if !forced && count > batcher.policy.MaximumBatch {
				// 非强制冲刷时只写入单批上限内的条目,剩余留到下一批。
				count = batcher.policy.MaximumBatch
			}
			batch := make([]JournalEntry, count)
			seenBatchIDs := make(map[string]struct{}, count)
			var previousTime time.Time
			for index := 0; index < count; index++ {
				batch[index] = cloneJournalEntry(pending[index])
				if _, duplicate := seenBatchIDs[batch[index].ID]; duplicate {
					return 0, fmt.Errorf("journal pending queue contains duplicate %s", batch[index].ID)
				}
				seenBatchIDs[batch[index].ID] = struct{}{}
				if _, err := batch[index].Canonical(); err != nil {
					return 0, fmt.Errorf("journal entry cannot be canonicalized: %w", err)
				}
				if !previousTime.IsZero() && batch[index].OccurredAt.Before(previousTime) {
					return 0, errors.New("journal pending entries are not chronological")
				}
				previousTime = batch[index].OccurredAt
			}
			callContext, cancel := context.WithTimeout(writeContext, batcher.policy.WriteTimeout)
			err := batcher.writer.WriteJournal(callContext, batch)
			cancel()
			if err != nil {
				return 0, fmt.Errorf("journal writer failed: %w", err)
			}
			for _, entry := range batch {
				delete(identifiers, entry.ID)
			}
			pending = append(pending[:0], pending[count:]...)
			batcher.mu.Lock()
			batcher.count = len(pending)
			batcher.mu.Unlock()
			return count, nil
		}
		for {
			select {
			case <-ctx.Done():
				for len(pending) > 0 {
					written, err := flush(context.Background(), false)
					if err != nil || written == 0 {
						runErr = errors.Join(ctx.Err(), err)
						return
					}
				}
				runErr = ctx.Err()
				return
			case request := <-batcher.append:
				if _, duplicate := identifiers[request.entry.ID]; duplicate {
					request.reply <- fmt.Errorf("duplicate journal entry: %s", request.entry.ID)
					continue
				}
				if len(pending) >= batcher.policy.MaximumPending {
					request.reply <- errors.New("journal pending capacity reached")
					continue
				}
				pending = append(pending, cloneJournalEntry(request.entry))
				sort.SliceStable(pending, func(left, right int) bool {
					if !pending[left].OccurredAt.Equal(pending[right].OccurredAt) {
						return pending[left].OccurredAt.Before(pending[right].OccurredAt)
					}
					return pending[left].ID < pending[right].ID
				})
				identifiers[request.entry.ID] = struct{}{}
				batcher.mu.Lock()
				batcher.count = len(pending)
				batcher.mu.Unlock()
				request.reply <- nil
				if len(pending) >= batcher.policy.MaximumBatch {
					_, _ = flush(ctx, false)
				}
			case request := <-batcher.drain:
				written := 0
				var drainErr error
				for len(pending) > 0 {
					count, err := flush(request.ctx, false)
					written += count
					if err != nil || count == 0 {
						drainErr = err
						break
					}
				}
				request.reply <- journalDrainResult{written: written, err: drainErr}
			case request := <-batcher.close:
				var closeErr error
				for len(pending) > 0 {
					written, err := flush(request.ctx, false)
					if err != nil || written == 0 {
						closeErr = err
						break
					}
				}
				batcher.mu.Lock()
				batcher.closed = true
				batcher.mu.Unlock()
				request.reply <- closeErr
				return
			case <-ticker.C:
				// 到冲刷间隔:把当前攒批的内容写入,避免日志长期滞留内存。
				_, _ = flush(ctx, false)
			}
		}
	})
	if runErr == nil {
		batcher.mu.Lock()
		alreadyClosed := batcher.closed
		batcher.mu.Unlock()
		if alreadyClosed {
			return nil
		}
		return errors.New("journal batcher can only be run once")
	}
	return runErr
}

// Drain 主动冲刷当前待处理队列,返回本次写出的条数与错误。
func (batcher *JournalBatcher) Drain(ctx context.Context) (int, error) {
	if ctx == nil {
		return 0, errors.New("journal drain context is required")
	}
	request := journalDrain{ctx: ctx, reply: make(chan journalDrainResult, 1)}
	select {
	case <-ctx.Done():
		return 0, ctx.Err()
	case <-batcher.done:
		return 0, ErrBatcherClosed
	case batcher.drain <- request:
	}
	select {
	case <-ctx.Done():
		return 0, ctx.Err()
	case result := <-request.reply:
		return result.written, result.err
	}
}

// Close 冲刷剩余条目后关闭批处理器;重复调用返回 nil。
func (batcher *JournalBatcher) Close(ctx context.Context) error {
	if ctx == nil {
		return errors.New("journal close context is required")
	}
	batcher.mu.Lock()
	if batcher.closed {
		batcher.mu.Unlock()
		return nil
	}
	batcher.mu.Unlock()
	request := journalClose{ctx: ctx, reply: make(chan error, 1)}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-batcher.done:
		return nil
	case batcher.close <- request:
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-request.reply:
		return err
	}
}

// Pending 返回当前待处理条目数,同时校验计数不变量。
func (batcher *JournalBatcher) Pending() int {
	batcher.mu.Lock()
	defer batcher.mu.Unlock()
	if batcher.count < 0 || batcher.count > batcher.policy.MaximumPending {
		panic("journal batcher pending count invariant violated")
	}
	return batcher.count
}
