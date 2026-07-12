package reconcile

import (
	"bytes"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"io"
	"sort"
	"strings"
	"time"
)

const receiptFrameVersion byte = 3

type ReceiptFrame struct {
	Sequence uint64
	Created  time.Time
	Receipts []Receipt
	Checksum uint32
}

func EncodeReceiptFrame(sequence uint64, created time.Time, receipts []Receipt) ([]byte, error) {
	if sequence == 0 || created.IsZero() {
		return nil, errors.New("frame sequence and creation time are required")
	}
	if len(receipts) == 0 || len(receipts) > 10_000 {
		return nil, errors.New("frame receipt count is outside supported range")
	}
	ordered := append([]Receipt(nil), receipts...)
	sort.SliceStable(ordered, func(left, right int) bool {
		if ordered[left].PaymentID != ordered[right].PaymentID {
			return ordered[left].PaymentID < ordered[right].PaymentID
		}
		return ordered[left].ReceiptID < ordered[right].ReceiptID
	})
	body := bytes.NewBuffer(make([]byte, 0, len(ordered)*180))
	_ = body.WriteByte(receiptFrameVersion)
	_ = binary.Write(body, binary.BigEndian, sequence)
	_ = binary.Write(body, binary.BigEndian, created.UTC().UnixNano())
	_ = binary.Write(body, binary.BigEndian, uint32(len(ordered)))
	for _, receipt := range ordered {
		if err := receipt.Validate(); err != nil {
			return nil, err
		}
		fields := []string{
			receipt.ReceiptID,
			receipt.PaymentID,
			receipt.BatchKey,
			receipt.Account,
			receipt.Beneficiary,
			string(receipt.Amount.Currency),
			receipt.Route,
			receipt.ProviderToken,
			receipt.EvidenceDigest,
		}
		for _, field := range fields {
			if len(field) > 65_535 {
				return nil, errors.New("receipt frame field is too large")
			}
			_ = binary.Write(body, binary.BigEndian, uint16(len(field)))
			_, _ = body.WriteString(field)
		}
		_ = binary.Write(body, binary.BigEndian, receipt.Amount.Minor)
		_ = binary.Write(body, binary.BigEndian, uint16(receipt.Attempt))
		_ = binary.Write(body, binary.BigEndian, receipt.CommittedAt.UTC().UnixNano())
	}
	checksum := crc32.Checksum(body.Bytes(), crc32.MakeTable(crc32.Castagnoli))
	_ = binary.Write(body, binary.BigEndian, checksum)
	return body.Bytes(), nil
}

func DecodeReceiptFrame(encoded []byte) (ReceiptFrame, error) {
	if len(encoded) < 25 {
		return ReceiptFrame{}, errors.New("receipt frame is truncated")
	}
	writtenChecksum := binary.BigEndian.Uint32(encoded[len(encoded)-4:])
	calculated := crc32.Checksum(encoded[:len(encoded)-4], crc32.MakeTable(crc32.Castagnoli))
	if writtenChecksum != calculated {
		return ReceiptFrame{}, errors.New("receipt frame checksum mismatch")
	}
	reader := bytes.NewReader(encoded[:len(encoded)-4])
	version, err := reader.ReadByte()
	if err != nil || version != receiptFrameVersion {
		return ReceiptFrame{}, errors.New("receipt frame version is unsupported")
	}
	var sequence uint64
	var unixNano int64
	var count uint32
	if binary.Read(reader, binary.BigEndian, &sequence) != nil ||
		binary.Read(reader, binary.BigEndian, &unixNano) != nil ||
		binary.Read(reader, binary.BigEndian, &count) != nil {
		return ReceiptFrame{}, errors.New("receipt frame header is truncated")
	}
	if sequence == 0 || count == 0 || count > 10_000 {
		return ReceiptFrame{}, errors.New("receipt frame header is invalid")
	}
	receipts := make([]Receipt, 0, count)
	for index := uint32(0); index < count; index++ {
		fields := make([]string, 9)
		for field := range fields {
			value, fieldErr := readFrameString(reader)
			if fieldErr != nil {
				return ReceiptFrame{}, fieldErr
			}
			fields[field] = value
		}
		var minor int64
		var attempt uint16
		var committedNano int64
		if binary.Read(reader, binary.BigEndian, &minor) != nil ||
			binary.Read(reader, binary.BigEndian, &attempt) != nil ||
			binary.Read(reader, binary.BigEndian, &committedNano) != nil {
			return ReceiptFrame{}, errors.New("receipt frame numeric field is truncated")
		}
		receipt := Receipt{
			ReceiptID:      fields[0],
			PaymentID:      fields[1],
			BatchKey:       fields[2],
			Account:        fields[3],
			Beneficiary:    fields[4],
			Amount:         Money{Currency: Currency(fields[5]), Minor: minor},
			Route:          fields[6],
			ProviderToken:  fields[7],
			Attempt:        int(attempt),
			CommittedAt:    time.Unix(0, committedNano).UTC(),
			EvidenceDigest: fields[8],
		}
		if validateErr := receipt.Validate(); validateErr != nil {
			return ReceiptFrame{}, validateErr
		}
		receipts = append(receipts, receipt)
	}
	if reader.Len() != 0 {
		return ReceiptFrame{}, errors.New("receipt frame has trailing bytes")
	}
	return ReceiptFrame{
		Sequence: sequence,
		Created:  time.Unix(0, unixNano).UTC(),
		Receipts: receipts,
		Checksum: writtenChecksum,
	}, nil
}

func FrameDigest(frame ReceiptFrame) string {
	parts := make([]string, 0, len(frame.Receipts)+3)
	parts = append(parts, string(receiptFrameVersion))
	parts = append(parts, frame.Created.UTC().Format(time.RFC3339Nano))
	for _, receipt := range frame.Receipts {
		parts = append(parts, receipt.ReceiptID+":"+receipt.EvidenceDigest)
	}
	return strings.Join(parts, "|")
}

func readFrameString(reader *bytes.Reader) (string, error) {
	var length uint16
	if err := binary.Read(reader, binary.BigEndian, &length); err != nil {
		return "", errors.New("receipt frame string length is truncated")
	}
	value := make([]byte, int(length))
	if _, err := io.ReadFull(reader, value); err != nil {
		return "", errors.New("receipt frame string value is truncated")
	}
	return string(value), nil
}
