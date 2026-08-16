use std::collections::BTreeMap;

/// 解析后的命令:动词 + 位置参数 + 键值赋值 + 标志位。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParsedCommand {
    /// 小写化的命令动词。
    pub verb: String,
    pub positional: Vec<String>,
    /// 形如 `key=value` 的赋值(键已小写化并去重)。
    pub assignments: BTreeMap<String, String>,
    /// 形如 `--flag` 的标志位(小写化、排序并去重)。
    pub flags: Vec<String>,
}

/// 支持引号与转义的命令行分词器,用于解析人工输入的交易/审计命令。
///
/// 规则:空白分隔单词;单双引号括起的内容作为整体保留;反斜杠转义 `n`/`r`/`t`/空格/引号/反斜杠。
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct QuoteTokenParser;

impl QuoteTokenParser {
    /// 将文本切分为词元。
    ///
    /// 使用单遍扫描:状态机在“转义中 / 引号内 / 普通”三种状态间切换,
    /// 结束后若仍处于引号或转义状态,说明输入残缺,直接报错。
    pub fn tokenize(&self, text: &str) -> Result<Vec<String>, String> {
        let mut tokens = Vec::new();
        let mut current = String::new();
        let mut quote = None;
        let mut escaped = false;
        for character in text.chars() {
            if escaped {
                match character {
                    'n' => current.push('\n'),
                    'r' => current.push('\r'),
                    't' => current.push('\t'),
                    // 允许转义空格/引号/反斜杠本身,方便把特殊字符塞进一个词元。
                    '\\' | '\'' | '"' | ' ' => current.push(character),
                    other => return Err(format!("unsupported escape sequence \\{other}")),
                }
                escaped = false;
                continue;
            }
            if character == '\\' {
                escaped = true;
                continue;
            }
            if let Some(active_quote) = quote {
                if character == active_quote {
                    quote = None;
                } else {
                    current.push(character);
                }
                continue;
            }
            if character == '"' || character == '\'' {
                quote = Some(character);
            } else if character.is_whitespace() {
                // 空白是词元边界;连续空白不产生空词元。
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            } else {
                current.push(character);
            }
        }
        if escaped {
            return Err("command ends with an escape marker".to_owned());
        }
        if quote.is_some() {
            return Err("command has an unterminated quote".to_owned());
        }
        if !current.is_empty() {
            tokens.push(current);
        }
        Ok(tokens)
    }

    /// 解析完整命令:首个词元为动词,其余按 `--flag`、`key=value`、普通参数三类处理。
    pub fn parse(&self, text: &str) -> Result<ParsedCommand, String> {
        let tokens = self.tokenize(text)?;
        let Some(first) = tokens.first() else {
            return Err("command is empty".to_owned());
        };
        // 动词只允许字母数字、连字符、下划线,避免把文件名或路径误当命令。
        if !first
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
        {
            return Err("command verb contains unsupported characters".to_owned());
        }
        let mut parsed = ParsedCommand {
            verb: first.to_ascii_lowercase(),
            positional: Vec::new(),
            assignments: BTreeMap::new(),
            flags: Vec::new(),
        };
        for token in tokens.into_iter().skip(1) {
            if let Some(flag) = token.strip_prefix("--") {
                // 标志位不允许为空或含 `=`(那是赋值语法)。
                if flag.is_empty() || flag.contains('=') {
                    return Err(format!("invalid flag {token}"));
                }
                parsed.flags.push(flag.to_ascii_lowercase());
            } else if let Some((key, value)) = token.split_once('=') {
                let key = key.trim().to_ascii_lowercase();
                if key.is_empty() || value.is_empty() {
                    return Err(format!("invalid assignment {token}"));
                }
                // 同一键重复赋值视为歧义输入。
                if parsed
                    .assignments
                    .insert(key.clone(), value.to_owned())
                    .is_some()
                {
                    return Err(format!("duplicate assignment {key}"));
                }
            } else {
                parsed.positional.push(token);
            }
        }
        // 排序去重使标志位集合规范化,便于幂等比较。
        parsed.flags.sort();
        parsed.flags.dedup();
        Ok(parsed)
    }

    /// 将命令渲染为规范化文本;与 `parse` 互为逆操作(往返保持内容一致)。
    pub fn render(&self, command: &ParsedCommand) -> Result<String, String> {
        if command.verb.trim().is_empty() {
            return Err("command verb is required".to_owned());
        }
        let mut tokens = vec![render_token(&command.verb)];
        tokens.extend(command.positional.iter().map(|value| render_token(value)));
        // BTreeMap 迭代天然有序,保证输出的赋值顺序稳定。
        tokens.extend(
            command
                .assignments
                .iter()
                .map(|(key, value)| render_token(&format!("{key}={value}"))),
        );
        let mut flags = command.flags.clone();
        flags.sort();
        flags.dedup();
        tokens.extend(flags.iter().map(|flag| format!("--{flag}")));
        Ok(tokens.join(" "))
    }
}

/// 渲染单个词元:含空白、引号或反斜杠时用双引号包裹并转义,否则原样输出。
fn render_token(value: &str) -> String {
    if value.is_empty()
        || value
            .chars()
            .any(|character| character.is_whitespace() || character == '"' || character == '\\')
    {
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        value.to_owned()
    }
}
