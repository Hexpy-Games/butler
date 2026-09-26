//! User-facing export request for importing profile candidates from another AI.

pub(crate) fn third_party_migration_prompt(locale: &str) -> String {
    if locale == "ko" {
        return [
            "지금까지 나에 대해 저장한 모든 기억과, 과거 대화에서 안정적으로 알게 된 장기 맥락을 내보내 주세요.",
            "가능하면 내 표현을 그대로 보존해 주세요. 특히 지시사항, 선호, 교정 요청은 원문에 가깝게 남겨 주세요.",
            "",
            "## Categories",
            "",
            "아래 순서와 섹션 이름을 그대로 사용해 주세요.",
            "",
            "1. **Instructions**: 앞으로 계속 따르라고 내가 명시적으로 요청한 규칙입니다. 말투, 형식, 스타일, \"항상 X\", \"절대 Y\", 행동 교정 요청을 포함합니다. 저장된 기억에 있는 규칙만 포함하고, 현재 대화에서 새로 추론한 규칙은 포함하지 마세요.",
            "",
            "2. **Identity**: 이름, 나이, 위치, 교육, 가족, 관계, 언어, 개인적 관심사처럼 오래 유지되는 자기 맥락입니다.",
            "",
            "3. **Career**: 현재/과거 역할, 회사, 업무 영역, 기술 스택, 일반적인 역량입니다.",
            "",
            "4. **Projects**: 내가 의미 있게 만들었거나 장기적으로 책임지고 있는 프로젝트입니다. 가능하면 프로젝트당 한 줄로 쓰고, 각 항목의 첫 단어는 프로젝트명 또는 짧은 식별자로 시작하세요. 무엇을 하는지, 현재 상태, 중요한 결정이 있으면 포함해 주세요.",
            "",
            "5. **Interests and Meaningful Context**: 최근 반복적으로 관심을 보인 주제, 오래 지속되는 관심사, 의미 있었던 사건이나 방향 전환입니다.",
            "",
            "6. **Preferences**: 넓게 적용되는 의견, 취향, 작업 방식, 설명 방식, 협업 방식, 검증 기대입니다.",
            "",
            "7. **Boundaries and Uncertainties**: 피해야 할 것, 민감한 영역, 확신이 낮은 추론입니다. 추론은 반드시 추론이라고 표시하세요.",
            "",
            "## Format",
            "",
            "각 범주는 섹션 헤더로 구분하고, 각 범주 안에는 한 줄에 한 항목만 적어 주세요. 오래된 날짜부터 최신 날짜 순서로 정렬하세요.",
            "",
            "각 줄은 다음 형식을 사용해 주세요:",
            "",
            "[YYYY-MM-DD] - 항목 내용",
            "",
            "날짜를 모르면 [unknown]을 사용하세요.",
            "",
            "## Output",
            "",
            "- 전체 export를 복사하기 쉽도록 하나의 코드 블록으로 감싸 주세요.",
            "- 코드 블록 뒤에는 이것이 완전한 전체 목록인지, 아니면 더 남아 있는지 한 문장으로 밝혀 주세요.",
            "- 비밀번호, 토큰, 인증키, 결제정보 같은 비밀은 절대 포함하지 마세요.",
            "",
            "출력 예시:",
            "```",
            "## Instructions",
            "[unknown] - ...",
            "",
            "## Identity",
            "[unknown] - ...",
            "```",
        ]
        .join("\n");
    }
    [
        "Export all of my stored memories and any durable context you've reliably learned about me from past conversations.",
        "Preserve my words verbatim where possible, especially for instructions, preferences, and corrections to your behavior.",
        "",
        "## Categories",
        "",
        "Use these section names and this order.",
        "",
        "1. **Instructions**: Rules I explicitly asked you to follow going forward: tone, format, style, \"always do X\", \"never do Y\", and corrections to your behavior. Only include rules from stored memories, not new inferences from this conversation.",
        "",
        "2. **Identity**: Name, age, location, education, family, relationships, languages, and personal interests.",
        "",
        "3. **Career**: Current and past roles, companies, work areas, technical stack, and general skill areas.",
        "",
        "4. **Projects**: Projects I meaningfully built or committed to. Ideally use one entry per project. Start each entry with the project name or a short descriptor, then include what it does, current status, and key decisions when known.",
        "",
        "5. **Interests and Meaningful Context**: Recent recurring interests, enduring interests, meaningful events, and turning points.",
        "",
        "6. **Preferences**: Opinions, tastes, working-style preferences, explanation preferences, collaboration preferences, and verification expectations that apply broadly.",
        "",
        "7. **Boundaries and Uncertainties**: Things to avoid, sensitive areas, and low-confidence inferences. Clearly label inferences as inference.",
        "",
        "## Format",
        "",
        "Use section headers for each category. Within each category, list one entry per line, sorted by oldest date first.",
        "",
        "Format each line as:",
        "",
        "[YYYY-MM-DD] - Entry content here.",
        "",
        "If no date is known, use [unknown] instead.",
        "",
        "## Output",
        "",
        "- Wrap the entire export in a single code block for easy copying.",
        "- After the code block, state whether this is the complete set or if more remain.",
        "- Never include passwords, tokens, API keys, payment data, or other secrets.",
        "",
        "Example:",
        "```",
        "## Instructions",
        "[unknown] - ...",
        "",
        "## Identity",
        "[unknown] - ...",
        "```",
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::third_party_migration_prompt;

    #[test]
    fn migration_prompt_is_static_secret_safe_and_locale_specific() {
        let english = third_party_migration_prompt("en");
        let korean = third_party_migration_prompt("ko");
        assert!(english.contains("Never include passwords, tokens, API keys"));
        assert!(korean.contains("비밀번호, 토큰, 인증키"));
        assert_ne!(english, korean);
    }
}
