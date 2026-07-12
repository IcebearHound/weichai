package reconcile

import (
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

type ReceiptStore interface {
	FindByPayment(paymentID string) (Receipt, bool, error)
	Save(receipt Receipt) (Receipt, bool, error)
	ListByBatch(batchKey string) ([]Receipt, error)
	Count() int
}

type MemoryReceiptStore struct {
	mu        sync.RWMutex
	byPayment map[string]Receipt
	byBatch   map[string][]string
	failures  map[string]error
}

func NewMemoryReceiptStore() *MemoryReceiptStore {
	return &MemoryReceiptStore{
		byPayment: make(map[string]Receipt),
		byBatch:   make(map[string][]string),
		failures:  make(map[string]error),
	}
}

func (store *MemoryReceiptStore) FindByPayment(paymentID string) (Receipt, bool, error) {
	store.mu.RLock()
	defer store.mu.RUnlock()
	if failure := store.failures["find:"+paymentID]; failure != nil {
		return Receipt{}, false, failure
	}
	receipt, exists := store.byPayment[paymentID]
	return receipt, exists, nil
}

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

func (store *MemoryReceiptStore) Count() int {
	store.mu.RLock()
	defer store.mu.RUnlock()
	return len(store.byPayment)
}

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

type BatchArchive struct {
	mu      sync.RWMutex
	records map[string]ArchivedBatch
}

type ArchivedBatch struct {
	Key         string
	Fingerprint string
	Entries     []BatchEntry
	StartedAt   time.Time
	FinishedAt  time.Time
	Revision    uint64
}

func NewBatchArchive() *BatchArchive {
	return &BatchArchive{records: make(map[string]ArchivedBatch)}
}

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

func (archive *BatchArchive) Get(key string) (ArchivedBatch, bool) {
	archive.mu.RLock()
	defer archive.mu.RUnlock()
	batch, exists := archive.records[key]
	return cloneArchivedBatch(batch), exists
}

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

func cloneArchivedBatch(batch ArchivedBatch) ArchivedBatch {
	batch.Entries = cloneEntries(batch.Entries)
	return batch
}
