package fanout

import (
	"errors"
	"fmt"
	"math"
	"time"
)

type BatchWindowInput struct {
	PendingRecords      int
	AverageRecordBytes  int
	WriterBytesPerSec   int
	WriterCallsPerSec   float64
	OldestRecordAge     time.Duration
	MaximumLatency      time.Duration
	MaximumBatchRecords int
	MaximumBatchBytes   int
	MemoryBudgetBytes   int
}

type BatchWindow struct {
	Records        int
	Bytes          int
	ExpectedWrite  time.Duration
	Immediate      bool
	CapacityReason string
}

type BatchWindowSizer struct{}

func (BatchWindowSizer) Size(input BatchWindowInput) (BatchWindow, error) {
	if input.PendingRecords < 0 {
		return BatchWindow{}, errors.New("pending records cannot be negative")
	}
	if input.AverageRecordBytes < 1 {
		return BatchWindow{}, errors.New("average record bytes must be positive")
	}
	if input.WriterBytesPerSec < 1 {
		return BatchWindow{}, errors.New("writer throughput must be positive")
	}
	if math.IsNaN(input.WriterCallsPerSec) || math.IsInf(input.WriterCallsPerSec, 0) || input.WriterCallsPerSec <= 0 {
		return BatchWindow{}, errors.New("writer call rate must be positive and finite")
	}
	if input.OldestRecordAge < 0 {
		return BatchWindow{}, errors.New("oldest record age cannot be negative")
	}
	if input.MaximumLatency <= 0 {
		return BatchWindow{}, errors.New("maximum latency must be positive")
	}
	if input.MaximumBatchRecords < 1 {
		return BatchWindow{}, errors.New("maximum batch records must be positive")
	}
	if input.MaximumBatchBytes < input.AverageRecordBytes {
		return BatchWindow{}, errors.New("maximum batch bytes cannot fit one average record")
	}
	if input.MemoryBudgetBytes < input.AverageRecordBytes {
		return BatchWindow{}, errors.New("memory budget cannot fit one average record")
	}
	if input.PendingRecords == 0 {
		return BatchWindow{CapacityReason: "empty"}, nil
	}
	byteLimited := input.MaximumBatchBytes / input.AverageRecordBytes
	memoryLimited := input.MemoryBudgetBytes / input.AverageRecordBytes
	callLimited := int(math.Ceil(float64(input.PendingRecords) / math.Max(1, input.WriterCallsPerSec)))
	latencyRemaining := input.MaximumLatency - input.OldestRecordAge
	if latencyRemaining < 0 {
		latencyRemaining = 0
	}
	throughputLimited := int(float64(input.WriterBytesPerSec) * math.Max(latencyRemaining.Seconds(), 0.001) /
		float64(input.AverageRecordBytes))
	if throughputLimited < 1 {
		throughputLimited = 1
	}
	records := input.PendingRecords
	reason := "pending"
	candidates := []struct {
		value  int
		reason string
	}{
		{input.MaximumBatchRecords, "record-limit"},
		{byteLimited, "byte-limit"},
		{memoryLimited, "memory-budget"},
		{throughputLimited, "latency-throughput"},
	}
	for _, candidate := range candidates {
		if candidate.value < records {
			records = candidate.value
			reason = candidate.reason
		}
	}
	if callLimited > records && callLimited <= input.MaximumBatchRecords && callLimited <= byteLimited {
		records = callLimited
		reason = "writer-call-efficiency"
	}
	if records < 1 {
		records = 1
		reason = "minimum-progress"
	}
	bytes := records * input.AverageRecordBytes
	expectedWrite := time.Duration(float64(bytes)/float64(input.WriterBytesPerSec)*float64(time.Second)) +
		time.Duration(float64(time.Second)/input.WriterCallsPerSec)
	immediate := input.OldestRecordAge >= input.MaximumLatency || input.PendingRecords >= records
	return BatchWindow{
		Records:        records,
		Bytes:          bytes,
		ExpectedWrite:  expectedWrite,
		Immediate:      immediate,
		CapacityReason: reason,
	}, nil
}

func (BatchWindowSizer) Bounds(input BatchWindowInput) (int, int, error) {
	window, err := (BatchWindowSizer{}).Size(input)
	if err != nil {
		return 0, 0, err
	}
	if input.PendingRecords == 0 {
		return 0, 0, nil
	}
	minimum := 1
	if input.OldestRecordAge < input.MaximumLatency/2 && input.PendingRecords > 1 {
		minimum = int(math.Ceil(float64(window.Records) / 4))
	}
	maximum := window.Records
	if minimum > maximum {
		return 0, 0, fmt.Errorf("batch bounds are inconsistent: %d > %d", minimum, maximum)
	}
	return minimum, maximum, nil
}
