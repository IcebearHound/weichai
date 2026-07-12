use std::collections::BTreeMap;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParsedCommand {
    pub verb: String,
    pub positional: Vec<String>,
    pub assignments: BTreeMap<String, String>,
    pub flags: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct QuoteTokenParser;

impl QuoteTokenParser {
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

    pub fn parse(&self, text: &str) -> Result<ParsedCommand, String> {
        let tokens = self.tokenize(text)?;
        let Some(first) = tokens.first() else {
            return Err("command is empty".to_owned());
        };
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
                if flag.is_empty() || flag.contains('=') {
                    return Err(format!("invalid flag {token}"));
                }
                parsed.flags.push(flag.to_ascii_lowercase());
            } else if let Some((key, value)) = token.split_once('=') {
                let key = key.trim().to_ascii_lowercase();
                if key.is_empty() || value.is_empty() {
                    return Err(format!("invalid assignment {token}"));
                }
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
        parsed.flags.sort();
        parsed.flags.dedup();
        Ok(parsed)
    }

    pub fn render(&self, command: &ParsedCommand) -> Result<String, String> {
        if command.verb.trim().is_empty() {
            return Err("command verb is required".to_owned());
        }
        let mut tokens = vec![render_token(&command.verb)];
        tokens.extend(command.positional.iter().map(|value| render_token(value)));
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
