package fanout

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

type QuotePath struct {
	Pair      Pair
	Provider  string
	Region    string
	Hops      []string
	Revision  uint64
	Encrypted bool
}

type QuotePathEncoder struct {
	Prefix      string
	MaximumHops int
}

func (encoder QuotePathEncoder) Encode(path QuotePath) (string, error) {
	if encoder.Prefix == "" || strings.ContainsAny(encoder.Prefix, "/?#") {
		return "", errors.New("quote path prefix is invalid")
	}
	if encoder.MaximumHops < 0 || encoder.MaximumHops > 100 {
		return "", errors.New("quote path hop limit is invalid")
	}
	if _, err := ParsePair(path.Pair.String()); err != nil {
		return "", err
	}
	if path.Provider == "" || len(path.Provider) > 64 {
		return "", errors.New("quote path provider is invalid")
	}
	if path.Region == "" || len(path.Region) > 64 {
		return "", errors.New("quote path region is invalid")
	}
	if len(path.Hops) > encoder.MaximumHops {
		return "", errors.New("quote path exceeds hop limit")
	}
	hops := make([]string, len(path.Hops))
	seen := make(map[string]struct{}, len(path.Hops))
	for index, hop := range path.Hops {
		trimmed := strings.TrimSpace(hop)
		if trimmed == "" || len(trimmed) > 64 {
			return "", fmt.Errorf("quote path hop %d is invalid", index)
		}
		if strings.ContainsAny(trimmed, "/?#,") {
			return "", fmt.Errorf("quote path hop %s contains reserved syntax", trimmed)
		}
		if _, duplicate := seen[trimmed]; duplicate {
			return "", fmt.Errorf("quote path hop repeats: %s", trimmed)
		}
		seen[trimmed] = struct{}{}
		hops[index] = trimmed
	}
	query := url.Values{}
	query.Set("provider", path.Provider)
	query.Set("region", path.Region)
	query.Set("revision", strconv.FormatUint(path.Revision, 10))
	query.Set("secure", strconv.FormatBool(path.Encrypted))
	if len(hops) > 0 {
		query.Set("hops", base64.RawURLEncoding.EncodeToString([]byte(strings.Join(hops, ","))))
	}
	pairSegment := path.Pair.Base + "-" + path.Pair.Counter
	return encoder.Prefix + "/" + pairSegment + "?" + query.Encode(), nil
}

func (encoder QuotePathEncoder) Decode(encoded string) (QuotePath, error) {
	if len(encoded) > 16_384 {
		return QuotePath{}, errors.New("encoded quote path is too long")
	}
	parsed, err := url.Parse(encoded)
	if err != nil {
		return QuotePath{}, fmt.Errorf("quote path URL parsing failed: %w", err)
	}
	segments := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(segments) != 2 || segments[0] != encoder.Prefix {
		return QuotePath{}, errors.New("encoded quote path prefix is invalid")
	}
	pairToken := strings.Replace(segments[1], "-", "/", 1)
	if strings.Count(segments[1], "-") != 1 {
		return QuotePath{}, errors.New("encoded quote path pair segment is invalid")
	}
	pair, err := ParsePair(pairToken)
	if err != nil {
		return QuotePath{}, err
	}
	query := parsed.Query()
	allowed := map[string]struct{}{
		"provider": {}, "region": {}, "revision": {}, "secure": {}, "hops": {},
	}
	keys := make([]string, 0, len(query))
	for key := range query {
		if _, ok := allowed[key]; !ok {
			return QuotePath{}, fmt.Errorf("encoded quote path has unknown query key: %s", key)
		}
		if len(query[key]) != 1 {
			return QuotePath{}, fmt.Errorf("encoded quote path repeats query key: %s", key)
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	provider := query.Get("provider")
	region := query.Get("region")
	revision, err := strconv.ParseUint(query.Get("revision"), 10, 64)
	if err != nil {
		return QuotePath{}, errors.New("encoded quote path revision is invalid")
	}
	secure, err := strconv.ParseBool(query.Get("secure"))
	if err != nil {
		return QuotePath{}, errors.New("encoded quote path secure flag is invalid")
	}
	hops := make([]string, 0)
	if hopText := query.Get("hops"); hopText != "" {
		decoded, decodeErr := base64.RawURLEncoding.DecodeString(hopText)
		if decodeErr != nil {
			return QuotePath{}, errors.New("encoded quote path hops are invalid")
		}
		hops = strings.Split(string(decoded), ",")
	}
	path := QuotePath{
		Pair:      pair,
		Provider:  provider,
		Region:    region,
		Hops:      hops,
		Revision:  revision,
		Encrypted: secure,
	}
	canonical, err := encoder.Encode(path)
	if err != nil {
		return QuotePath{}, err
	}
	if canonical != encoded {
		return QuotePath{}, errors.New("encoded quote path is not canonical")
	}
	return path, nil
}
