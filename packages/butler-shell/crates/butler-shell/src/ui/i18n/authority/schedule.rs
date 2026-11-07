//! The schedule, access, image and clock copy of the authority card.
use butler_ds::ui::context::Lang;

use super::Authority;

impl Authority {
    /// interfaceTemplates.approvalRequest.schedule{Unavailable, Mode, Signin, Payment}
    pub(crate) fn schedule_unavailable(self) -> &'static str {
        self.pick(
            "Schedule details unavailable.",
            "예약 작업 정보를 확인할 수 없어요.",
        )
    }

    pub(crate) fn schedule_mode(self, mode: &str) -> String {
        match self.0 {
            Lang::En => format!("Run permission: {mode}"),
            Lang::Ko => format!("실행 권한: {mode}"),
        }
    }

    pub(crate) fn schedule_signin(self, on: bool) -> String {
        match self.0 {
            Lang::En => format!("Use sign-in info · {}", if on { "On" } else { "Off" }),
            Lang::Ko => format!("로그인 정보 사용 · {}", if on { "켜짐" } else { "꺼짐" }),
        }
    }

    pub(crate) fn schedule_payment(self, on: bool) -> String {
        match self.0 {
            Lang::En => format!("Use payment info · {}", if on { "On" } else { "Off" }),
            Lang::Ko => format!("결제 정보 사용 · {}", if on { "켜짐" } else { "꺼짐" }),
        }
    }

    /// permissions.{auto, readOnly, askAlways, askFirst, fullAccess}
    pub(crate) fn access_label(self, mode: &str) -> &'static str {
        match mode {
            "auto" => self.pick("Auto", "알아서 진행"),
            "read_only" => self.pick("Read only", "읽기 전용"),
            "ask_first" => self.pick("Ask every time", "모두 확인"),
            "ask_except_reads" => self.pick("Ask first", "먼저 확인"),
            _ => self.pick("Full access", "전체 권한"),
        }
    }

    /// conversation.imageTools: model, size, qualityLabel, prompt, default, quality.*
    pub(crate) fn image_labels(self) -> [&'static str; 5] {
        [
            self.pick("Model", "모델"),
            self.pick("Size", "크기"),
            self.pick("Quality", "품질"),
            self.pick("Prompt", "프롬프트"),
            self.pick("Default", "기본"),
        ]
    }

    pub(crate) fn image_quality(self, quality: &str) -> Option<&'static str> {
        Some(match quality {
            "low" => self.pick("Low", "낮음"),
            "medium" => self.pick("Medium", "보통"),
            "high" => self.pick("High", "높음"),
            "xhigh" => self.pick("Very high", "매우 높음"),
            "max" => self.pick("Max", "최고"),
            _ => return None,
        })
    }

    /// automations: once, everyMinutes, everyHours, everySeconds, dailyAt, weekdaysAt
    pub(crate) fn once(self) -> &'static str {
        self.pick("Once", "한 번")
    }

    pub(crate) fn every(self, seconds: i64) -> String {
        match self.0 {
            Lang::En if seconds % 3600 == 0 => match seconds / 3600 {
                1 => "Every hour".to_owned(),
                n => format!("Every {n} hours"),
            },
            Lang::En if seconds % 60 == 0 => format!("Every {} minutes", seconds / 60),
            Lang::En => format!("Every {seconds} seconds"),
            Lang::Ko if seconds % 3600 == 0 => format!("{}시간마다", seconds / 3600),
            Lang::Ko if seconds % 60 == 0 => format!("{}분마다", seconds / 60),
            Lang::Ko => format!("{seconds}초마다"),
        }
    }

    /// conversation.initiated.dailyAt, weekdaysAt
    pub(crate) fn daily_at(self, time: &str) -> String {
        match self.0 {
            Lang::En => format!("Daily at {time}"),
            Lang::Ko => format!("매일 {time}"),
        }
    }

    pub(crate) fn weekdays_at(self, time: &str) -> String {
        match self.0 {
            Lang::En => format!("Weekdays at {time}"),
            Lang::Ko => format!("평일 {time}"),
        }
    }

    /// automations.next
    pub(crate) fn next(self, time: &str) -> String {
        match self.0 {
            Lang::En => format!("Next: {time}"),
            Lang::Ko => format!("다음: {time}"),
        }
    }
}
