package fanout

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

type DigestMessage struct {
	MessageID string
	AccountID string
	Sequence  uint64
	Headers   map[string]string
	Payload   []byte
}

type MessageDigest struct {
	Namespace string
	Key       []byte
}

func (digest MessageDigest) Sum(message DigestMessage) (string, error) {
	if digest.Namespace == "" || len(digest.Namespace) > 64 {
		return "", errors.New("message digest namespace is invalid")
	}
	if len(digest.Key) < 16 || len(digest.Key) > 128 {
		return "", errors.New("message digest key length is outside supported range")
	}
	if message.MessageID == "" || len(message.MessageID) > 100 {
		return "", errors.New("digest message identifier is invalid")
	}
	if message.AccountID == "" || len(message.AccountID) > 64 {
		return "", errors.New("digest account identifier is invalid")
	}
	if len(message.Headers) > 100 {
		return "", errors.New("digest message has too many headers")
	}
	if len(message.Payload) > 64*1024*1024 {
		return "", errors.New("digest payload exceeds sixty-four megabytes")
	}
	keys := make([]string, 0, len(message.Headers))
	for key, value := range message.Headers {
		if key == "" || len(key) > 100 {
			return "", errors.New("digest header name is invalid")
		}
		if len(value) > 8_192 {
			return "", errors.New("digest header value is too long")
		}
		keys = append(keys, strings.ToLower(key))
	}
	sort.Strings(keys)
	hash := sha256.New()
	hash.Write(digest.Key)
	hash.Write([]byte{0})
	hash.Write([]byte(digest.Namespace))
	hash.Write([]byte{0})
	hash.Write([]byte(message.MessageID))
	hash.Write([]byte{0})
	hash.Write([]byte(message.AccountID))
	hash.Write([]byte{0})
	hash.Write([]byte(strconv.FormatUint(message.Sequence, 10)))
	hash.Write([]byte{0})
	for _, normalizedKey := range keys {
		var value string
		for originalKey, candidate := range message.Headers {
			if strings.EqualFold(originalKey, normalizedKey) {
				value = candidate
				break
			}
		}
		hash.Write([]byte(normalizedKey))
		hash.Write([]byte{'='})
		hash.Write([]byte(value))
		hash.Write([]byte{0})
	}
	hash.Write(message.Payload)
	return digest.Namespace + ":" + hex.EncodeToString(hash.Sum(nil)), nil
}

func (digest MessageDigest) Verify(message DigestMessage, expected string) error {
	actual, err := digest.Sum(message)
	if err != nil {
		return err
	}
	if len(expected) != len(actual) {
		return errors.New("message digest length differs")
	}
	if subtle.ConstantTimeCompare([]byte(actual), []byte(expected)) != 1 {
		return fmt.Errorf("message digest mismatch for %s", message.MessageID)
	}
	return nil
}
