package reconcile

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"
)

// TransferOperation 是单次渠道转账操作:接收单笔支付与尝试序号(从 1 开始),
// 返回渠道侧的转账结果。实现必须尊重 context 取消,以便超时控制生效。
type TransferOperation func(context.Context, Payment, int) (TransferResult, error)

// CoordinatorConfig 配置协调器的并行度与超时:WorkerLimit 限制并发的支付
// 提交数,AttemptTimeout 是单次转账的最长耗时,Clock 可注入以便测试,
// RetryPolicy 控制失败后的退避重试。
type CoordinatorConfig struct {
	WorkerLimit    int
	AttemptTimeout time.Duration
	Clock          func() time.Time
	RetryPolicy    *RetryPolicy
}

// batchFlight 代表一次正在执行中的批次:指纹用于幂等比对,done 在批次完成
// 时关闭以便后续加入者等待,entries/failure 保存最终结果。
type batchFlight struct {
	fingerprint string
	done        chan struct{}
	entries     []BatchEntry
	failure     error
}

// BatchCommitCoordinator 是批量提交的并发协调器:同一幂等键的并发请求会
// 合并为一次执行(见 flights),同一支付身份的并发提交由 paymentLocks 串行化,
// 保证“一笔支付只入账一次”。所有指标累计在 metrics 中供观测。
type BatchCommitCoordinator struct {
	receipts ReceiptStore
	archive  *BatchArchive
	config   CoordinatorConfig

	mu           sync.Mutex
	flights      map[string]*batchFlight
	paymentLocks map[string]*paymentGate
	metrics      CoordinatorMetrics
}

// paymentGate 是支付身份级的锁:references 记录当前持有该锁的提交者数量,
// 归零时删除,避免锁表无限增长。
type paymentGate struct {
	lock       sync.Mutex
	references int
}

// CoordinatorMetrics 记录协调器的运行指标:批次启动/合并/重放/冲突计数、
// 支付尝试与复用计数、转账成败、重试调度数,以及当前在途批次与锁的数量。
type CoordinatorMetrics struct {
	BatchesStarted     uint64
	BatchesJoined      uint64
	BatchesReplayed    uint64
	BatchConflicts     uint64
	PaymentsAttempted  uint64
	PaymentsReused     uint64
	TransfersSucceeded uint64
	TransfersFailed    uint64
	RetriesScheduled   uint64
	ActiveBatches      int
	ActivePaymentGates int
}

// NewBatchCommitCoordinator 构造协调器并校验配置;缺省时使用系统时钟与
// 默认退避策略(1ms 起、2 倍增长、上限 50ms)。
func NewBatchCommitCoordinator(receipts ReceiptStore, archive *BatchArchive, config CoordinatorConfig) (*BatchCommitCoordinator, error) {
	if receipts == nil {
		return nil, errors.New("receipt store is required")
	}
	if archive == nil {
		return nil, errors.New("batch archive is required")
	}
	if config.WorkerLimit < 1 || config.WorkerLimit > 256 {
		return nil, errors.New("worker limit must be between one and 256")
	}
	if config.AttemptTimeout <= 0 {
		return nil, errors.New("attempt timeout must be positive")
	}
	if config.Clock == nil {
		config.Clock = time.Now
	}
	if config.RetryPolicy == nil {
		policy, _ := NewRetryPolicy(time.Millisecond, 50*time.Millisecond, 2, 0, 1)
		config.RetryPolicy = policy
	}
	return &BatchCommitCoordinator{
		receipts:     receipts,
		archive:      archive,
		config:       config,
		flights:      make(map[string]*batchFlight),
		paymentLocks: make(map[string]*paymentGate),
	}, nil
}

// Reconcile 是提交入口,依次执行:请求校验 -> 指纹计算 -> 归档查重(键冲突
// 或历史重放直接返回)-> 合并并发执行(leader 承担实际工作,其余等待)。
// 成功后把批次与结果写入归档,再从归档取回规范化副本返回。
func (coordinator *BatchCommitCoordinator) Reconcile(
	ctx context.Context,
	request CommitRequest,
	transfer TransferOperation,
) ([]BatchEntry, error) {
	if transfer == nil {
		return nil, errors.New("transfer operation is required")
	}
	if err := request.Validate(); err != nil {
		return invalidEntries(request.Payments, err), err
	}
	fingerprint := request.Fingerprint()
	if archived, exists := coordinator.archive.Get(request.IdempotencyKey); exists {
		if archived.Fingerprint != fingerprint {
			coordinator.incrementConflict()
			return nil, &BatchConflictError{
				Key:                 request.IdempotencyKey,
				ExistingFingerprint: archived.Fingerprint,
				IncomingFingerprint: fingerprint,
			}
		}
		coordinator.incrementReplay()
		return cloneEntries(archived.Entries), nil
	}

	flight, leader, err := coordinator.joinOrCreateFlight(request.IdempotencyKey, fingerprint)
	if err != nil {
		return nil, err
	}
	if !leader {
		// 非 leader 的并发请求阻塞等待同键批次完成,再取最终结果返回,
		// 从而对调用方呈现“同一幂等键只有一次执行”的语义。
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-flight.done:
			return cloneEntries(flight.entries), flight.failure
		}
	}

	started := coordinator.config.Clock().UTC()
	entries, executeErr := coordinator.executeBatch(ctx, request, transfer)
	finished := coordinator.config.Clock().UTC()
	if executeErr == nil {
		archived, archiveErr := coordinator.archive.Put(ArchivedBatch{
			Key:         request.IdempotencyKey,
			Fingerprint: fingerprint,
			Entries:     entries,
			StartedAt:   started,
			FinishedAt:  finished,
		})
		if archiveErr != nil {
			executeErr = archiveErr
		} else {
			entries = archived.Entries
		}
	}
	coordinator.completeFlight(request.IdempotencyKey, flight, entries, executeErr)
	return cloneEntries(entries), executeErr
}

// executeBatch 并发执行批内全部支付:以信号量限制在途 goroutine 数不超过
// WorkerLimit,context 取消时尚未开始执行的支付直接标记失败。
func (coordinator *BatchCommitCoordinator) executeBatch(
	ctx context.Context,
	request CommitRequest,
	transfer TransferOperation,
) ([]BatchEntry, error) {
	entries := make([]BatchEntry, len(request.Payments))
	semaphore := make(chan struct{}, coordinator.config.WorkerLimit)
	var workers sync.WaitGroup
	for position, payment := range request.Payments {
		position := position
		payment := payment
		workers.Add(1)
		go func() {
			defer workers.Done()
			select {
			case semaphore <- struct{}{}:
				defer func() { <-semaphore }()
			case <-ctx.Done():
				entries[position] = failedEntry(position, payment.Identity, 0, ClassifyTransferError(ctx.Err()))
				return
			}
			entries[position] = coordinator.commitPayment(ctx, request, position, payment, transfer)
		}()
	}
	workers.Wait()
	return entries, nil
}

// commitPayment 提交单笔支付:先取支付级锁与历史回执比对(已成功则复用,
// 细节不一致则判冲突),否则按最大尝试次数循环调用渠道,失败按退避策略
// 等待后重试,期间响应 context 取消与批次截止时间。
func (coordinator *BatchCommitCoordinator) commitPayment(
	ctx context.Context,
	request CommitRequest,
	position int,
	payment Payment,
	transfer TransferOperation,
) BatchEntry {
	gate := coordinator.acquirePaymentGate(payment.Identity)
	gate.lock.Lock()
	defer func() {
		gate.lock.Unlock()
		coordinator.releasePaymentGate(payment.Identity, gate)
	}()

	prior, exists, lookupErr := coordinator.receipts.FindByPayment(payment.Identity)
	if lookupErr != nil {
		return failedEntry(position, payment.Identity, 0, &CommitFailure{
			Kind:    FailurePermanent,
			Message: "receipt lookup failed",
			Cause:   lookupErr,
		})
	}
	if exists {
		if prior.Account != payment.Account || prior.Beneficiary != payment.Beneficiary || prior.Amount != payment.Amount {
			return failedEntry(position, payment.Identity, 0, &CommitFailure{
				Kind:    FailureConflict,
				Message: "payment identity already names different transfer details",
			})
		}
		coordinator.mu.Lock()
		coordinator.metrics.PaymentsReused++
		coordinator.mu.Unlock()
		copyReceipt := prior
		return BatchEntry{Position: position, PaymentID: payment.Identity, Receipt: &copyReceipt}
	}

	var lastFailure *CommitFailure
	for attempt := 1; attempt <= request.MaximumAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			lastFailure = ClassifyTransferError(err)
			return failedEntry(position, payment.Identity, attempt-1, lastFailure)
		}
		if !request.Deadline.IsZero() && !coordinator.config.Clock().Before(request.Deadline) {
			// 批次截止已到,不再发起新的转账尝试,按超时失败结束。
			lastFailure = &CommitFailure{Kind: FailureTimeout, Message: "batch deadline elapsed", Retryable: false}
			return failedEntry(position, payment.Identity, attempt-1, lastFailure)
		}

		coordinator.mu.Lock()
		coordinator.metrics.PaymentsAttempted++
		coordinator.mu.Unlock()
		attemptContext, cancel := context.WithTimeout(ctx, coordinator.config.AttemptTimeout)
		result, transferErr := transfer(attemptContext, payment, attempt)
		cancel()
		if transferErr == nil {
			receipt := coordinator.makeReceipt(request.IdempotencyKey, payment, attempt, result)
			stored, _, saveErr := coordinator.receipts.Save(receipt)
			if saveErr != nil {
				lastFailure = &CommitFailure{Kind: FailurePermanent, Message: "receipt persistence failed", Cause: saveErr}
				coordinator.mu.Lock()
				coordinator.metrics.TransfersFailed++
				coordinator.mu.Unlock()
				return failedEntry(position, payment.Identity, attempt, lastFailure)
			}
			coordinator.mu.Lock()
			coordinator.metrics.TransfersSucceeded++
			coordinator.mu.Unlock()
			copyReceipt := stored
			return BatchEntry{Position: position, PaymentID: payment.Identity, Receipt: &copyReceipt, Attempts: attempt}
		}

		lastFailure = ClassifyTransferError(transferErr)
		coordinator.mu.Lock()
		coordinator.metrics.TransfersFailed++
		coordinator.mu.Unlock()
		decision := coordinator.config.RetryPolicy.Decide(attempt, request.MaximumAttempts, lastFailure)
		if decision.Stop {
			return failedEntry(position, payment.Identity, attempt, lastFailure)
		}
		coordinator.mu.Lock()
		coordinator.metrics.RetriesScheduled++
		coordinator.mu.Unlock()
		if waitErr := WaitForRetry(ctx, decision.Delay); waitErr != nil {
			return failedEntry(position, payment.Identity, attempt, ClassifyTransferError(waitErr))
		}
	}
	if lastFailure == nil {
		lastFailure = &CommitFailure{Kind: FailureRetryBudget, Message: "payment exhausted its retry budget"}
	}
	return failedEntry(position, payment.Identity, request.MaximumAttempts, lastFailure)
}

// makeReceipt 由转账结果生成回执:证据摘要对键、支付指纹、渠道凭证、路由与
// 时间求哈希;渠道未返回提交时间时回退到协调器时钟。
func (coordinator *BatchCommitCoordinator) makeReceipt(batchKey string, payment Payment, attempt int, result TransferResult) Receipt {
	committedAt := result.CommittedAt.UTC()
	if committedAt.IsZero() {
		committedAt = coordinator.config.Clock().UTC()
	}
	evidence := sha256.New()
	writeFingerprintPart(evidence, batchKey)
	writeFingerprintPart(evidence, payment.Fingerprint())
	writeFingerprintPart(evidence, result.ProviderToken)
	writeFingerprintPart(evidence, result.Route)
	writeFingerprintPart(evidence, committedAt.Format(time.RFC3339Nano))
	digest := hex.EncodeToString(evidence.Sum(nil))
	// 回执 ID 取“键+支付+渠道凭证”摘要的前 12 字节:同键同凭证的重放
	// 必然生成相同 ID,便于幂等;截断长度足以区分同批内不同支付。
	identityMaterial := sha256.Sum256([]byte(batchKey + "\x00" + payment.Identity + "\x00" + result.ProviderToken))
	return Receipt{
		ReceiptID:      "rcpt_" + hex.EncodeToString(identityMaterial[:12]),
		PaymentID:      payment.Identity,
		BatchKey:       batchKey,
		Account:        payment.Account,
		Beneficiary:    payment.Beneficiary,
		Amount:         payment.Amount,
		Route:          result.Route,
		ProviderToken:  result.ProviderToken,
		Attempt:        attempt,
		CommittedAt:    committedAt,
		EvidenceDigest: digest,
	}
}

// joinOrCreateFlight 登记或加入同键批次:已存在同指纹批次则作为加入者返回;
// 指纹不同则报幂等冲突;不存在则创建新批次并成为 leader。
func (coordinator *BatchCommitCoordinator) joinOrCreateFlight(key, fingerprint string) (*batchFlight, bool, error) {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	if running, exists := coordinator.flights[key]; exists {
		if running.fingerprint != fingerprint {
			coordinator.metrics.BatchConflicts++
			return nil, false, &BatchConflictError{
				Key:                 key,
				ExistingFingerprint: running.fingerprint,
				IncomingFingerprint: fingerprint,
			}
		}
		coordinator.metrics.BatchesJoined++
		return running, false, nil
	}
	created := &batchFlight{fingerprint: fingerprint, done: make(chan struct{})}
	coordinator.flights[key] = created
	coordinator.metrics.BatchesStarted++
	coordinator.metrics.ActiveBatches++
	return created, true, nil
}

// completeFlight 写入批次结果并关闭 done 通知等待者,随后从在途表中移除。
func (coordinator *BatchCommitCoordinator) completeFlight(key string, flight *batchFlight, entries []BatchEntry, failure error) {
	coordinator.mu.Lock()
	flight.entries = cloneEntries(entries)
	flight.failure = failure
	if coordinator.flights[key] == flight {
		delete(coordinator.flights, key)
	}
	coordinator.metrics.ActiveBatches--
	close(flight.done)
	coordinator.mu.Unlock()
}

// acquirePaymentGate 获取支付身份对应的锁(不存在则创建),引用计数加一。
func (coordinator *BatchCommitCoordinator) acquirePaymentGate(identity string) *paymentGate {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	gate := coordinator.paymentLocks[identity]
	if gate == nil {
		gate = &paymentGate{}
		coordinator.paymentLocks[identity] = gate
	}
	gate.references++
	coordinator.metrics.ActivePaymentGates = len(coordinator.paymentLocks)
	return gate
}

// releasePaymentGate 释放支付锁引用,归零时删除锁条目。
func (coordinator *BatchCommitCoordinator) releasePaymentGate(identity string, gate *paymentGate) {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	gate.references--
	if gate.references == 0 && coordinator.paymentLocks[identity] == gate {
		delete(coordinator.paymentLocks, identity)
	}
	coordinator.metrics.ActivePaymentGates = len(coordinator.paymentLocks)
}

// Metrics 返回当前累计指标的副本。
func (coordinator *BatchCommitCoordinator) Metrics() CoordinatorMetrics {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	return coordinator.metrics
}

// incrementReplay 累计历史批次重放计数。
func (coordinator *BatchCommitCoordinator) incrementReplay() {
	coordinator.mu.Lock()
	coordinator.metrics.BatchesReplayed++
	coordinator.mu.Unlock()
}

// incrementConflict 累计幂等冲突计数。
func (coordinator *BatchCommitCoordinator) incrementConflict() {
	coordinator.mu.Lock()
	coordinator.metrics.BatchConflicts++
	coordinator.mu.Unlock()
}

// invalidEntries 为校验失败的批次生成逐笔“无效”结果,供调用方区分校验期
// 失败与执行期失败。
func invalidEntries(payments []Payment, validation error) []BatchEntry {
	entries := make([]BatchEntry, len(payments))
	for position, payment := range payments {
		entries[position] = failedEntry(position, payment.Identity, 0, &CommitFailure{
			Kind:    FailureInvalid,
			Message: "batch validation failed at payment " + strconv.Itoa(position),
			Cause:   validation,
		})
	}
	return entries
}

// failedEntry 构造单笔失败结果;failure 为空时兜底为未知的永久失败。
func failedEntry(position int, paymentID string, attempts int, failure *CommitFailure) BatchEntry {
	if failure == nil {
		failure = &CommitFailure{Kind: FailurePermanent, Message: "unknown transfer failure"}
	}
	return BatchEntry{Position: position, PaymentID: paymentID, Attempts: attempts, Failure: failure}
}

// FormatBatchFailure 汇总批次的失败情况:全部成功返回 nil,否则返回失败笔数
// 与首个失败原因,便于上层快速定位问题。
func FormatBatchFailure(entries []BatchEntry) error {
	failed := 0
	first := ""
	for _, entry := range entries {
		if entry.Successful() {
			continue
		}
		failed++
		if first == "" && entry.Failure != nil {
			first = entry.Failure.Error()
		}
	}
	if failed == 0 {
		return nil
	}
	return fmt.Errorf("%d of %d payments failed; first failure: %s", failed, len(entries), first)
}
