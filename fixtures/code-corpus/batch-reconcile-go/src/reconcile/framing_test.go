package reconcile

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"strings"
	"testing"
	"time"
)

// frameReceipt 构造一条合法的测试回执,证据摘要按身份首字符填充 64 位十六进制。
func frameReceipt(identity string, minor int64, currency Currency, offset time.Duration) Receipt {
	return Receipt{
		ReceiptID:      "frame-receipt-" + identity,
		PaymentID:      "frame-payment-" + identity,
		BatchKey:       "frame-batch-main",
		Account:        "frame-source-" + identity,
		Beneficiary:    "frame-target-" + identity,
		Amount:         Money{Currency: currency, Minor: minor},
		Route:          "frame-route",
		ProviderToken:  "frame-provider-" + identity,
		Attempt:        2,
		CommittedAt:    testEpoch.Add(offset),
		EvidenceDigest: strings.Repeat(identity[:1], 64),
	}
}

// TestReceiptFrameRoundTripSortsDeterministically 验证编解码往返一致:乱序输入
// 经编码后按 PaymentID 排序,解码得到的回执顺序确定,且每条均通过校验。
func TestReceiptFrameRoundTripSortsDeterministically(t *testing.T) {
	receipts := []Receipt{
		frameReceipt("c", 300, CurrencyGBP, 3*time.Second),
		frameReceipt("a", 100, CurrencyUSD, time.Second),
		frameReceipt("b", 200, CurrencyEUR, 2*time.Second),
	}
	encoded, err := EncodeReceiptFrame(42, testEpoch, receipts)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if encoded[0] != receiptFrameVersion {
		t.Errorf("version byte %d", encoded[0])
	}
	decoded, err := DecodeReceiptFrame(encoded)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if decoded.Sequence != 42 || !decoded.Created.Equal(testEpoch) || len(decoded.Receipts) != 3 {
		t.Fatalf("decoded header: %+v", decoded)
	}
	if decoded.Receipts[0].PaymentID != "frame-payment-a" || decoded.Receipts[1].PaymentID != "frame-payment-b" || decoded.Receipts[2].PaymentID != "frame-payment-c" {
		t.Errorf("receipt order: %+v", decoded.Receipts)
	}
	for index, receipt := range decoded.Receipts {
		if err := receipt.Validate(); err != nil {
			t.Errorf("receipt %d: %v", index, err)
		}
	}
	if decoded.Checksum == 0 {
		t.Error("checksum should be populated")
	}
}

// TestReceiptFrameEncodingIsIndependentOfInputOrder 验证编码结果与输入顺序无关
// (帧内排序),同时确认序号参与编码,不同序列号会产生不同字节。
func TestReceiptFrameEncodingIsIndependentOfInputOrder(t *testing.T) {
	first := frameReceipt("a", 100, CurrencyUSD, time.Second)
	second := frameReceipt("b", 200, CurrencyEUR, 2*time.Second)
	forward, err := EncodeReceiptFrame(7, testEpoch, []Receipt{first, second})
	if err != nil {
		t.Fatalf("forward encode: %v", err)
	}
	reverse, err := EncodeReceiptFrame(7, testEpoch, []Receipt{second, first})
	if err != nil {
		t.Fatalf("reverse encode: %v", err)
	}
	if !bytes.Equal(forward, reverse) {
		t.Error("frame encoding changed with input order")
	}
	changed, err := EncodeReceiptFrame(8, testEpoch, []Receipt{first, second})
	if err != nil {
		t.Fatalf("changed encode: %v", err)
	}
	if bytes.Equal(forward, changed) {
		t.Error("sequence should affect encoded bytes")
	}
}

// TestReceiptFrameDetectsCorruption 在帧的多个位置(头部、中部、尾部)翻转字节,
// 验证解码都能以“校验和不匹配”拒绝被篡改的数据。
func TestReceiptFrameDetectsCorruption(t *testing.T) {
	encoded, err := EncodeReceiptFrame(9, testEpoch, []Receipt{frameReceipt("a", 100, CurrencyUSD, 0)})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	for _, index := range []int{0, 5, len(encoded) / 2, len(encoded) - 5} {
		corrupted := append([]byte(nil), encoded...)
		corrupted[index] ^= 0x5a
		if _, err := DecodeReceiptFrame(corrupted); err == nil || !strings.Contains(err.Error(), "checksum") {
			t.Errorf("corruption at %d error: %v", index, err)
		}
	}
}

// TestReceiptFrameRejectsInvalidHeaders 验证编码侧对非法头部(零序号、零时间、
// 空回执)的拒绝,以及解码侧对截断帧的拒绝。
func TestReceiptFrameRejectsInvalidHeaders(t *testing.T) {
	if _, err := EncodeReceiptFrame(0, testEpoch, []Receipt{frameReceipt("a", 1, CurrencyUSD, 0)}); err == nil {
		t.Error("zero sequence should fail")
	}
	if _, err := EncodeReceiptFrame(1, time.Time{}, []Receipt{frameReceipt("a", 1, CurrencyUSD, 0)}); err == nil {
		t.Error("zero creation time should fail")
	}
	if _, err := EncodeReceiptFrame(1, testEpoch, nil); err == nil {
		t.Error("empty receipts should fail")
	}
	if _, err := DecodeReceiptFrame([]byte{receiptFrameVersion, 1, 2}); err == nil || !strings.Contains(err.Error(), "truncated") {
		t.Errorf("short frame error: %v", err)
	}
}

// TestReceiptFrameRejectsWrongVersionWithValidChecksum 篡改版本字节并重新计算
// 合法校验和,验证版本检查独立于校验和,旧/未知版本仍被拒绝。
func TestReceiptFrameRejectsWrongVersionWithValidChecksum(t *testing.T) {
	encoded, err := EncodeReceiptFrame(11, testEpoch, []Receipt{frameReceipt("b", 99, CurrencyCAD, 0)})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	encoded[0] = 99
	checksum := crc32Checksum(encoded[:len(encoded)-4])
	binary.BigEndian.PutUint32(encoded[len(encoded)-4:], checksum)
	if _, err := DecodeReceiptFrame(encoded); err == nil || !strings.Contains(err.Error(), "version") {
		t.Errorf("wrong version error: %v", err)
	}
}

// TestReceiptFrameRejectsTrailingBodyBytes 在帧体后追加字节并重算校验和,验证
// 解码端能识别出多余载荷并拒绝,防止伪造帧携带附加数据。
func TestReceiptFrameRejectsTrailingBodyBytes(t *testing.T) {
	encoded, err := EncodeReceiptFrame(12, testEpoch, []Receipt{frameReceipt("c", 125, CurrencyCHF, 0)})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	body := append([]byte(nil), encoded[:len(encoded)-4]...)
	body = append(body, 0xde, 0xad, 0xbe, 0xef)
	checksum := crc32Checksum(body)
	mutated := append(body, make([]byte, 4)...)
	binary.BigEndian.PutUint32(mutated[len(mutated)-4:], checksum)
	if _, err := DecodeReceiptFrame(mutated); err == nil || !strings.Contains(err.Error(), "trailing") {
		t.Errorf("trailing body error: %v", err)
	}
}

// TestFrameDigestReflectsOrderAndEvidence 验证摘要对回执顺序与证据摘要敏感:
// 顺序或证据变化必然导致摘要变化。
func TestFrameDigestReflectsOrderAndEvidence(t *testing.T) {
	left := frameReceipt("a", 100, CurrencyUSD, 0)
	right := frameReceipt("b", 200, CurrencyEUR, time.Second)
	frame := ReceiptFrame{Sequence: 1, Created: testEpoch, Receipts: []Receipt{left, right}}
	original := FrameDigest(frame)
	reordered := frame
	reordered.Receipts = []Receipt{right, left}
	if FrameDigest(reordered) == original {
		t.Error("digest should reflect receipt order")
	}
	changed := frame
	changed.Receipts = append([]Receipt(nil), frame.Receipts...)
	changed.Receipts[0].EvidenceDigest = strings.Repeat("f", 64)
	if FrameDigest(changed) == original {
		t.Error("digest should reflect evidence")
	}
}

// crc32Checksum 用与帧编解码相同的 Castagnoli 表计算校验和,供测试构造
// “校验和合法但内容非法”的恶意帧。
func crc32Checksum(data []byte) uint32 {
	return crc32.Checksum(data, crc32.MakeTable(crc32.Castagnoli))
}
