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

// receiptFrameVersion 是回执帧的二进制格式版本号。解码端据此拒绝不兼容的
// 旧格式;格式演进时递增版本号而不是复用旧版本。
const receiptFrameVersion byte = 3

// ReceiptFrame 是一次批次提交的全部回执组成的可持久化/可传输单元:唯一序号
// Sequence、创建时间与回执列表,尾部附带整帧的 CRC 校验和。
type ReceiptFrame struct {
	Sequence uint64
	Created  time.Time
	Receipts []Receipt
	Checksum uint32
}

// EncodeReceiptFrame 将一批回执编码为二进制帧。帧内容按 PaymentID、ReceiptID
// 稳定排序,使同一批回执无论到达顺序如何都得到完全相同的字节,从而支持
// 去重与内容寻址。布局:版本号 + 序号 + 创建时间 + 回执数 + 逐条回执
// (变长字符串带长度前缀)+ 尾部 CRC32(Castagnoli)校验和。
func EncodeReceiptFrame(sequence uint64, created time.Time, receipts []Receipt) ([]byte, error) {
	if sequence == 0 || created.IsZero() {
		return nil, errors.New("frame sequence and creation time are required")
	}
	if len(receipts) == 0 || len(receipts) > 10_000 {
		return nil, errors.New("frame receipt count is outside supported range")
	}
	// 拷贝后再排序,避免改动调用方的切片;稳定排序保证同键回执的相对顺序不变。
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
	// Castagnoli 多项式在硬件加速平台上校验速度更快,适合大帧场景。
	checksum := crc32.Checksum(body.Bytes(), crc32.MakeTable(crc32.Castagnoli))
	_ = binary.Write(body, binary.BigEndian, checksum)
	return body.Bytes(), nil
}

// DecodeReceiptFrame 从字节还原 ReceiptFrame:先取帧尾的写入校验和与正文
// 重新计算的校验和比对,防止传输损坏;随后逐字段解析,并复用餐户的
// Receipt.Validate 校验每条回执的语义完整性。
func DecodeReceiptFrame(encoded []byte) (ReceiptFrame, error) {
	if len(encoded) < 25 {
		return ReceiptFrame{}, errors.New("receipt frame is truncated")
	}
	// 校验和固定在帧尾 4 字节,故先剥离校验和再对正文计算,与编码侧一致。
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
	// 解析完毕后必须无剩余字节,避免伪造帧携带未知的附加载荷蒙混过关。
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

// FrameDigest 生成帧的人类可读摘要:版本 + 创建时间 + 每条回执的
// “回执 ID:证据摘要”。摘要不用于加密安全校验,仅用于日志定位与快速比对。
func FrameDigest(frame ReceiptFrame) string {
	parts := make([]string, 0, len(frame.Receipts)+3)
	parts = append(parts, string(receiptFrameVersion))
	parts = append(parts, frame.Created.UTC().Format(time.RFC3339Nano))
	for _, receipt := range frame.Receipts {
		parts = append(parts, receipt.ReceiptID+":"+receipt.EvidenceDigest)
	}
	return strings.Join(parts, "|")
}

// readFrameString 按“uint16 长度前缀 + 原文字节”的格式读取一个字符串字段,
// 并对截断给出可定位的错误。长度上限 65535 与编码侧校验保持一致。
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
