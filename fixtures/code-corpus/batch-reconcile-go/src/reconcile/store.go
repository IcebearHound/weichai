package reconcile

import (
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

// ReceiptStore 是回执的持久化抽象。实现需要保证:同一 PaymentID 至多保存
// 一条回执;Save 对内容一致的重放返回已存在结果;FindByPayment 能查询任意
// 历史回执,便于对账与幂等恢复。
type ReceiptStore interface {
	FindByPayment(paymentID string) (Receipt, bool, error)
	Save(receipt Receipt) (Receipt, bool, error)
	ListByBatch(batchKey string) ([]Receipt, error)
	Count() int
}

// MemoryReceiptStore 是 ReceiptStore 的内存实现,供测试与单机演示使用。
// failures 表支持按操作注入故障,用于验证调用方对存储异常的重试与降级行为。
type MemoryReceiptStore struct {
	mu        sync.RWMutex
	byPayment map[string]Receipt
	byBatch   map[string][]string
	failures  map[string]error
}

// NewMemoryReceiptStore 构造空的回执存储。
func NewMemoryReceiptStore() *MemoryReceiptStore {
	return &MemoryReceiptStore{
		byPayment: make(map[string]Receipt),
		byBatch:   make(map[string][]string),
		failures:  make(map[string]error),
	}
}

// FindByPayment 按支付 ID 查询回执;返回的 bool 表示是否存在。
func (store *MemoryReceiptStore) FindByPayment(paymentID string) (Receipt, bool, error) {
	store.mu.RLock()
	defer store.mu.RUnlock()
	if failure := store.failures["find:"+paymentID]; failure != nil {
		return Receipt{}, false, failure
	}
	receipt, exists := store.byPayment[paymentID]
	return receipt, exists, nil
}

// Save 保存回执。同一 PaymentID 重复保存时,若新老回执的关键内容一致则返回
// 已存在的旧回执且不重复入库(幂等);内容不一致则报错,防止同一支付被
// 不同批次改写成不同结果。
func (store *MemoryReceiptStore) Save(receipt Receipt) (Receipt, bool, error) {
	if err := receipt.Validate(); err != nil {
		return Receipt{}, false, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if failure := store.failures["save:"+receipt.PaymentID]; failure != nil {
		return Receipt{}, false, failure
	}
	if prior, exists := store.byPayment[receipt.PaymentID]; exists {
		if prior.BatchKey != receipt.BatchKey || prior.Amount != receipt.Amount || prior.Account != receipt.Account {
			return Receipt{}, false, fmt.Errorf("payment %s already has an incompatible receipt", receipt.PaymentID)
		}
		return prior, false, nil
	}
	store.byPayment[receipt.PaymentID] = receipt
	store.byBatch[receipt.BatchKey] = append(store.byBatch[receipt.BatchKey], receipt.PaymentID)
	return receipt, true, nil
}

// ListByBatch 按批次键列出该批的全部回执,结果按提交时间(同时间按回执 ID)
// 稳定排序,保证多次查询顺序一致。
func (store *MemoryReceiptStore) ListByBatch(batchKey string) ([]Receipt, error) {
	store.mu.RLock()
	defer store.mu.RUnlock()
	if failure := store.failures["list:"+batchKey]; failure != nil {
		return nil, failure
	}
	identities := store.byBatch[batchKey]
	result := make([]Receipt, 0, len(identities))
	for _, identity := range identities {
		if receipt, exists := store.byPayment[identity]; exists {
			result = append(result, receipt)
		}
	}
	sort.Slice(result, func(left, right int) bool {
		if result[left].CommittedAt.Equal(result[right].CommittedAt) {
			return result[left].ReceiptID < result[right].ReceiptID
		}
		return result[left].CommittedAt.Before(result[right].CommittedAt)
	})
	return result, nil
}

// Count 返回已保存的回执总数,用于健康检查与容量告警。
func (store *MemoryReceiptStore) Count() int {
	store.mu.RLock()
	defer store.mu.RUnlock()
	return len(store.byPayment)
}

// InjectFailure 向存储注入或清除故障:设置后,对应的 find/save/list 操作会
// 返回该错误。专用于测试故障注入,生产代码不应调用。
func (store *MemoryReceiptStore) InjectFailure(operation, identity string, failure error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	key := operation + ":" + identity
	if failure == nil {
		delete(store.failures, key)
	} else {
		store.failures[key] = failure
	}
}

// BatchArchive 按幂等键归档批次,保存键与指纹的对应关系及每笔结果,用于
// 冲突检测与事后审计。
type BatchArchive struct {
	mu      sync.RWMutex
	records map[string]ArchivedBatch
}

// ArchivedBatch 是归档后的批次快照:包含结果条目、时间范围与修订号
// (Revision,当前恒为 1,为未来多版本留位)。
type ArchivedBatch struct {
	Key         string
	Fingerprint string
	Entries     []BatchEntry
	StartedAt   time.Time
	FinishedAt  time.Time
	Revision    uint64
}

// NewBatchArchive 构造空归档。
func NewBatchArchive() *BatchArchive {
	return &BatchArchive{records: make(map[string]ArchivedBatch)}
}

// Put 归档一个批次。若键已存在且指纹一致,视为重复提交,返回已归档的旧
// 批次而不覆盖;指纹不一致则返回 BatchConflictError,提示调用方键被误用。
func (archive *BatchArchive) Put(batch ArchivedBatch) (ArchivedBatch, error) {
	if batch.Key == "" || batch.Fingerprint == "" {
		return ArchivedBatch{}, errors.New("archive key and fingerprint are required")
	}
	archive.mu.Lock()
	defer archive.mu.Unlock()
	if prior, exists := archive.records[batch.Key]; exists {
		if prior.Fingerprint != batch.Fingerprint {
			return ArchivedBatch{}, &BatchConflictError{
				Key:                 batch.Key,
				ExistingFingerprint: prior.Fingerprint,
				IncomingFingerprint: batch.Fingerprint,
			}
		}
		return cloneArchivedBatch(prior), nil
	}
	batch.Revision = 1
	batch.Entries = cloneEntries(batch.Entries)
	archive.records[batch.Key] = batch
	return cloneArchivedBatch(batch), nil
}

// Get 按键取回归档批次,不存在时返回 false。
func (archive *BatchArchive) Get(key string) (ArchivedBatch, bool) {
	archive.mu.RLock()
	defer archive.mu.RUnlock()
	batch, exists := archive.records[key]
	return cloneArchivedBatch(batch), exists
}

// Summaries 返回全部已归档批次的汇总;按键排序输出,保证报表顺序稳定。
func (archive *BatchArchive) Summaries() []BatchSummary {
	archive.mu.RLock()
	defer archive.mu.RUnlock()
	keys := make([]string, 0, len(archive.records))
	for key := range archive.records {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]BatchSummary, 0, len(keys))
	for _, key := range keys {
		batch := archive.records[key]
		result = append(result, SummarizeBatch(key, batch.Fingerprint, batch.Entries, batch.StartedAt, batch.FinishedAt))
	}
	return result
}

// cloneEntries 深拷贝条目切片:回执与失败信息均为指针,需逐字段复制以避免
// 归档内部状态被调用方意外改动,以及调用方持有的副本被归档后续修改污染。
func cloneEntries(entries []BatchEntry) []BatchEntry {
	copyEntries := make([]BatchEntry, len(entries))
	for index, entry := range entries {
		copyEntries[index] = entry
		if entry.Receipt != nil {
			receipt := *entry.Receipt
			copyEntries[index].Receipt = &receipt
		}
		if entry.Failure != nil {
			failure := *entry.Failure
			copyEntries[index].Failure = &failure
		}
	}
	return copyEntries
}

// cloneArchivedBatch 返回批次的深拷贝副本。
func cloneArchivedBatch(batch ArchivedBatch) ArchivedBatch {
	batch.Entries = cloneEntries(batch.Entries)
	return batch
}
