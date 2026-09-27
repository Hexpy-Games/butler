// Adapted from Bun's BSD-licensed JSDateMath-v8 parser. See LICENSE.txt.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Kind {
    Number,
    Symbol(u8),
    Month,
    Zone,
    Separator,
    AmPm,
    Word,
    Space,
    Unknown,
    End,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct Token {
    pub(super) kind: Kind,
    pub(super) value: i64,
    pub(super) length: usize,
}

impl Token {
    fn new(kind: Kind, value: i64, length: usize) -> Self {
        Self {
            kind,
            value,
            length,
        }
    }
    pub(super) fn number(self) -> Option<i64> {
        (self.kind == Kind::Number).then_some(self.value)
    }
    pub(super) fn fixed(self, length: usize, minimum: i64, maximum: i64) -> bool {
        self.kind == Kind::Number
            && self.length == length
            && (minimum..=maximum).contains(&self.value)
    }
    pub(super) fn sign(self) -> Option<i64> {
        match self.kind {
            Kind::Symbol(b'+') => Some(1),
            Kind::Symbol(b'-') => Some(-1),
            _ => None,
        }
    }
    pub(super) fn z(self) -> bool {
        self.kind == Kind::Zone && self.length == 1 && self.value == 0
    }
    pub(super) fn milliseconds(self) -> i64 {
        if self.length < 3 {
            self.value * 10_i64.pow(u32::try_from(3 - self.length).unwrap_or(u32::MAX))
        } else {
            self.value / 10_i64.pow(u32::try_from(self.length.min(9) - 3).unwrap_or(u32::MAX))
        }
    }
}

pub(super) struct Scanner<'a> {
    input: &'a [u8],
    offset: usize,
    pub(super) peek: Token,
}

impl<'a> Scanner<'a> {
    pub(super) fn new(text: &'a str) -> Self {
        let mut scanner = Self {
            input: text.as_bytes(),
            offset: 0,
            peek: Token::new(Kind::End, 0, 0),
        };
        scanner.peek = scanner.scan();
        scanner
    }
    fn byte(&self) -> u8 {
        self.input.get(self.offset).copied().unwrap_or(0)
    }
    pub(super) fn next(&mut self) -> Token {
        let current = self.peek;
        self.peek = self.scan();
        current
    }
    pub(super) fn symbol(&mut self, symbol: u8) -> bool {
        if self.peek.kind == Kind::Symbol(symbol) {
            self.next();
            true
        } else {
            false
        }
    }
    fn scan(&mut self) -> Token {
        let byte = self.byte();
        if byte == 0 {
            return Token::new(Kind::End, 0, 0);
        }
        let start = self.offset;
        if byte.is_ascii_digit() {
            while self.byte() == b'0' {
                self.offset += 1;
            }
            let mut value = 0;
            let mut significant = 0;
            while self.byte().is_ascii_digit() {
                if significant < 9 {
                    value = value * 10 + i64::from(self.byte() - b'0');
                }
                significant += 1;
                self.offset += 1;
            }
            return Token::new(Kind::Number, value, self.offset - start);
        }
        if matches!(byte, b':' | b'-' | b'+' | b'.' | b')') {
            self.offset += 1;
            return Token::new(Kind::Symbol(byte), 0, 1);
        }
        if byte >= b'A' && !white(byte) {
            let mut prefix = [0; 3];
            while self.byte() >= b'A' && !white(self.byte()) {
                if self.offset - start < 3 {
                    prefix[self.offset - start] = self.byte() | 0x20;
                }
                self.offset += 1;
            }
            let length = self.offset - start;
            let (kind, value) = keyword(prefix, length);
            return Token::new(kind, value, length);
        }
        self.offset += 1;
        if white(byte) {
            return Token::new(Kind::Space, 0, 1);
        }
        if byte == b'(' {
            let mut depth = 1;
            while depth > 0 && self.byte() != 0 {
                match self.byte() {
                    b'(' => depth += 1,
                    b')' => depth -= 1,
                    _ => {}
                }
                self.offset += 1;
            }
        }
        Token::new(Kind::Unknown, 0, self.offset - start)
    }
}

fn white(byte: u8) -> bool {
    byte == b' ' || (b'\t'..=b'\r').contains(&byte)
}

fn keyword(prefix: [u8; 3], length: usize) -> (Kind, i64) {
    const MONTHS: [&[u8; 3]; 12] = [
        b"jan", b"feb", b"mar", b"apr", b"may", b"jun", b"jul", b"aug", b"sep", b"oct", b"nov",
        b"dec",
    ];
    if let Some(index) = MONTHS.iter().position(|name| **name == prefix) {
        return (Kind::Month, i64::try_from(index).unwrap_or(i64::MAX) + 1);
    }
    if length > 3 {
        return (Kind::Word, 0);
    }
    match &prefix {
        b"am\0" => (Kind::AmPm, 0),
        b"pm\0" => (Kind::AmPm, 12),
        b"ut\0" | b"utc" | b"z\0\0" | b"gmt" => (Kind::Zone, 0),
        b"cdt" | b"est" => (Kind::Zone, -5),
        b"cst" | b"mdt" => (Kind::Zone, -6),
        b"edt" => (Kind::Zone, -4),
        b"mst" | b"pdt" => (Kind::Zone, -7),
        b"pst" => (Kind::Zone, -8),
        b"t\0\0" => (Kind::Separator, 0),
        _ => (Kind::Word, 0),
    }
}
