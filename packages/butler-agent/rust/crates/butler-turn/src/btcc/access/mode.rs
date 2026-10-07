use super::AccessMode;

impl AccessMode {
    pub const ALL: [Self; 4] = [
        Self::ReadOnly,
        Self::AskAlways,
        Self::AskExceptReads,
        Self::FullAccess,
    ];
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ReadOnly => "read_only",
            Self::AskAlways => "ask_first",
            Self::AskExceptReads => "ask_except_reads",
            Self::FullAccess => "full_access",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|mode| mode.as_str() == value)
    }
    pub fn rank(&self) -> u8 {
        match self {
            Self::ReadOnly => 0,
            Self::AskAlways => 1,
            Self::AskExceptReads => 2,
            Self::FullAccess => 4,
        }
    }
    pub fn narrower(self, other: Self) -> Self {
        if self.rank() <= other.rank() {
            self
        } else {
            other
        }
    }
    pub fn reviews_effects(&self) -> bool {
        matches!(self, Self::AskAlways | Self::AskExceptReads)
    }
}
