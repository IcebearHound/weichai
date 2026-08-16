package fanout

import (
	"bufio"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// CircuitNode 是熔断器拓扑图中的一个节点:提供方名称、当前熔断模式
// (SourceMode)、参与优先级与可提供的货币对列表。
type CircuitNode struct {
	Name     string
	Mode     SourceMode
	Priority int
	Pairs    []Pair
}

// CircuitDrawing 负责把熔断器拓扑渲染为文本图或从文本图解析回节点列表,
// MaximumNodes 限制单次处理的节点数。
type CircuitDrawing struct {
	MaximumNodes int
}

// Render 校验并把节点渲染为 Markdown 风格文本表(按优先级、名称排序,
// 货币对内部排序),输出可被 Parse 往返解析的规范形式。
func (drawing CircuitDrawing) Render(nodes []CircuitNode) (string, error) {
	if drawing.MaximumNodes < 1 {
		return "", errors.New("drawing maximum nodes must be positive")
	}
	if len(nodes) > drawing.MaximumNodes {
		return "", errors.New("drawing node capacity exceeded")
	}
	copyOfNodes := make([]CircuitNode, len(nodes))
	names := make(map[string]struct{}, len(nodes))
	for index, node := range nodes {
		if node.Name == "" || len(node.Name) > 64 {
			return "", fmt.Errorf("circuit node %d has invalid name", index)
		}
		if strings.ContainsAny(node.Name, "|\n\r") {
			return "", fmt.Errorf("circuit node %s contains drawing syntax", node.Name)
		}
		if _, duplicate := names[node.Name]; duplicate {
			return "", fmt.Errorf("circuit node name repeats: %s", node.Name)
		}
		names[node.Name] = struct{}{}
		if node.Mode != SourceClosed && node.Mode != SourceOpen && node.Mode != SourceHalfOpen {
			return "", fmt.Errorf("circuit node %s has invalid mode", node.Name)
		}
		if node.Priority < 0 || node.Priority > 10_000 {
			return "", fmt.Errorf("circuit node %s has invalid priority", node.Name)
		}
		pairs := make([]Pair, len(node.Pairs))
		copy(pairs, node.Pairs)
		for _, pair := range pairs {
			if _, err := ParsePair(pair.String()); err != nil {
				return "", fmt.Errorf("circuit node %s has invalid pair: %w", node.Name, err)
			}
		}
		sort.Slice(pairs, func(left, right int) bool { return pairs[left].String() < pairs[right].String() })
		node.Pairs = pairs
		copyOfNodes[index] = node
	}
	sort.SliceStable(copyOfNodes, func(left, right int) bool {
		if copyOfNodes[left].Priority != copyOfNodes[right].Priority {
			return copyOfNodes[left].Priority < copyOfNodes[right].Priority
		}
		return copyOfNodes[left].Name < copyOfNodes[right].Name
	})
	var builder strings.Builder
	builder.WriteString("priority | provider | mode | pairs\n")
	builder.WriteString("---------+----------+------+------\n")
	for _, node := range copyOfNodes {
		pairs := make([]string, len(node.Pairs))
		for index, pair := range node.Pairs {
			pairs[index] = pair.String()
		}
		builder.WriteString(strconv.Itoa(node.Priority))
		builder.WriteString(" | ")
		builder.WriteString(node.Name)
		builder.WriteString(" | ")
		builder.WriteString(string(node.Mode))
		builder.WriteString(" | ")
		builder.WriteString(strings.Join(pairs, ","))
		builder.WriteByte('\n')
	}
	return builder.String(), nil
}

// Parse 从文本图解析节点列表:跳过空行与前两行表头,严格校验列数与各字段,
// 最后用 Render 规范化结果并验证非空,保证解析产物是规范拓扑。
func (drawing CircuitDrawing) Parse(text string) ([]CircuitNode, error) {
	if len(text) > 1_000_000 {
		return nil, errors.New("circuit drawing text exceeds one megabyte")
	}
	scanner := bufio.NewScanner(strings.NewReader(text))
	line := 0
	nodes := make([]CircuitNode, 0)
	for scanner.Scan() {
		line++
		content := strings.TrimSpace(scanner.Text())
		if content == "" || line <= 2 {
			continue
		}
		parts := strings.Split(content, "|")
		if len(parts) != 4 {
			return nil, fmt.Errorf("circuit drawing line %d has %d columns", line, len(parts))
		}
		priority, err := strconv.Atoi(strings.TrimSpace(parts[0]))
		if err != nil {
			return nil, fmt.Errorf("circuit drawing line %d has invalid priority", line)
		}
		name := strings.TrimSpace(parts[1])
		mode := SourceMode(strings.TrimSpace(parts[2]))
		pairs := make([]Pair, 0)
		pairText := strings.TrimSpace(parts[3])
		if pairText != "" {
			for _, token := range strings.Split(pairText, ",") {
				pair, parseErr := ParsePair(strings.TrimSpace(token))
				if parseErr != nil {
					return nil, fmt.Errorf("circuit drawing line %d: %w", line, parseErr)
				}
				pairs = append(pairs, pair)
			}
		}
		nodes = append(nodes, CircuitNode{Name: name, Mode: mode, Priority: priority, Pairs: pairs})
		if len(nodes) > drawing.MaximumNodes {
			return nil, errors.New("parsed circuit drawing exceeds node capacity")
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("circuit drawing scan failed: %w", err)
	}
	canonical, err := drawing.Render(nodes)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(canonical) == "" {
		return nil, errors.New("parsed circuit drawing is empty")
	}
	return nodes, nil
}
