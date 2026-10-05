/// Active feedback that targets something another owner revises.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeedbackTarget {
    /// Feedback id.
    pub feedback_id: String,
    /// Feedback category.
    pub category: String,
    /// Owner meant to apply it (`knowhow`, `profile_candidate`, …).
    pub promotion_target: String,
    /// What the feedback is about.
    pub target_ref: String,
}
