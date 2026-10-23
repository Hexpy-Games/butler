use super::*;

impl Batch<'_, '_> {
    pub(super) fn execute(&mut self, op: &Operation) -> Result<()> {
        if matches!(op, Operation::Complete { .. } | Operation::Submit { .. })
            && let Some(hold) = control::active_holds(self.tx, &self.scope.session_id)?.first()
        {
            return Err(Error::Conflict {
                current: json!({"instruction_id":hold["id"]}),
            });
        }
        if matches!(op, Operation::Complete { .. } | Operation::Submit { .. })
            && let Some(instruction) =
                control::next_pending(self.tx, &self.scope.session_id, true)?.first()
        {
            return Err(Error::Conflict {
                current: json!({"instruction_id":instruction["id"]}),
            });
        }
        let (task_id, part_id) = self.execution_target(op)?;
        if matches!(
            op,
            Operation::Start { .. } | Operation::PartStart { .. } | Operation::Submit { .. }
        ) {
            self.start_or_submit(op, &task_id, part_id.as_deref())?;
        } else {
            self.settle(op, &task_id)?;
        }
        let current = revision(&read_task(self.tx, &task_id)?)?;
        self.revisions.insert(task_id, current);
        Ok(())
    }
    fn execution_target(&self, op: &Operation) -> Result<(String, Option<String>)> {
        Ok(match op {
            Operation::PartStart { part_id } => {
                let row = self.part(part_id)?;
                (
                    text(&row, "task_id")?.into(),
                    Some(text(&row, "id")?.to_owned()),
                )
            }
            Operation::Start { task_id }
            | Operation::Submit { task_id, .. }
            | Operation::Review { task_id, .. }
            | Operation::Complete { task_id, .. }
            | Operation::Block { task_id, .. }
            | Operation::Fail { task_id, .. } => {
                let row = self.task(task_id)?;
                (text(&row, "id")?.to_owned(), None)
            }
            _ => return Err(Error::Invalid("not an execution op")),
        })
    }
    fn start_here(&mut self, id: &str) -> Result<()> {
        if let Some(detail) = ownership::owned_elsewhere(self.tx, id, &self.scope.session_id)? {
            if self.keys.values().any(|created| created == id) {
                return Err(Error::Invalid(
                    "Each Task you plan runs in its own session, which the runtime starts when its step is ready. Do not `task.start` those Tasks here. Their results come back to this conversation, and you report them.",
                ));
            }
            return Err(Error::OwnedElsewhere { detail });
        }
        let receipt = start_task(
            self.tx,
            self.ctx,
            id,
            revision(&read_task(self.tx, id)?)?,
            &self.execution_scope(),
            &self.id(IdKind::Attempt)?,
        )?;

        if let Some(checkpoint) = receipt["prior_context"].as_str() {
            let body = tool_read::body(self.tx, checkpoint)?;
            self.task_contexts.insert(id.to_owned(),json!({"attempt_id":receipt["attempt_id"],"checkpoint_ref":checkpoint,"checkpoint":body}));
        }
        Ok(())
    }
    fn start_or_submit(&mut self, op: &Operation, id: &str, part_id: Option<&str>) -> Result<()> {
        if matches!(op, Operation::Start { .. }) {
            return self.start_here(id);
        }
        let scope = self.execution_scope();
        match op {
            Operation::PartStart { .. } => {
                let part = part_id.ok_or(Error::Invalid("part id"))?;
                start_part(
                    self.tx,
                    self.ctx,
                    part,
                    revision(&parts::read_part(self.tx, part)?)?,
                    &scope,
                    &self.id(IdKind::Attempt)?,
                )?;
            }
            Operation::Submit {
                part_id,
                result_refs,
                evidence_refs,
                ..
            } => {
                let part = part_id.as_ref().map(|p| self.resolve(p)).transpose()?;
                submit_task(
                    self.tx,
                    self.ctx,
                    id,
                    &scope,
                    &Submission {
                        part_id: part.as_deref(),
                        result_id: &self.id(IdKind::Result)?,
                        result_refs,
                        evidence_refs,
                    },
                )?;
            }
            _ => return Err(Error::Invalid("not a start/submit op")),
        }
        Ok(())
    }
    fn settle(&mut self, op: &Operation, id: &str) -> Result<()> {
        match op {
            Operation::Review {
                key,
                result_revision,
                verdict,
                criterion_results,
                ..
            } => {
                let review = self.id(IdKind::Review)?;
                review_task(
                    self.tx,
                    self.ctx,
                    id,
                    &self.scope.session_id,
                    &ReviewInput {
                        result_revision: *result_revision,
                        review_id: &review,
                        accept: matches!(verdict, Verdict::Accept),
                        judgments: criterion_results,
                    },
                )?;
                self.remember(key.as_deref(), &review)?;
            }
            Operation::Complete { review_ref, .. } => {
                complete_task(
                    self.tx,
                    self.ctx,
                    id,
                    &self.scope.session_id,
                    &self.resolve(review_ref)?,
                    !self.scope.child_session,
                )?;
            }
            Operation::Block {
                part_id,
                reason,
                checkpoint_ref,
                ..
            } => {
                let part = part_id.as_ref().map(|p| self.resolve(p)).transpose()?;
                block_task(
                    self.tx,
                    self.ctx,
                    id,
                    part.as_deref(),
                    &self.scope.session_id,
                    reason,
                    checkpoint_ref.as_deref(),
                )?;
            }
            Operation::Fail { reason, .. } => {
                fail_task(self.tx, self.ctx, id, &self.scope.session_id, reason)?;
            }
            _ => return Err(Error::Invalid("not an execution op")),
        }
        Ok(())
    }
}
