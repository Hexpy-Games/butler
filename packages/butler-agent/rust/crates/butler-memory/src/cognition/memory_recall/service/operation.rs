use super::super::query::PreparedSelection;
use super::*;

impl Operation {
    pub(super) async fn run(mut self) -> CognitionResult<RecallResponse> {
        let permit = self.read_permit().await?;
        if self.shutdown.is_cancelled() {
            return Err(closed());
        }
        let page = self
            .input
            .cursor
            .as_deref()
            .map(|cursor| self.cursors.read(cursor, (self.clock)()))
            .transpose()?;
        // Generation is pinned before any future vector suspension. No SQLite
        // transaction or canonical reader exists until the blocking query begins.
        let generation = resolve_active_generation(&self.data_root, &self.environment)?;
        if let Some(page) = &page {
            self.check_continuation(page, &generation)?;
        }
        let vector = if page.is_none() && self.input.include_vector {
            self.vector_facts(&generation).await?
        } else {
            VectorFacts::default()
        };
        let (generation, prepared, permit) = if page.is_none() && self.judge_port.is_some() {
            let operation = self.clone();
            let facts = vector.clone();
            // Move the only generation reader pin into blocking preparation. It
            // drops there with the readers, before any model wait begins.
            let mut prepared = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                operation.prepare(&generation, &facts)
            })
            .await
            .map_err(|source| closed().with_source(source))??;
            let started = std::time::Instant::now();
            self.judge(&mut prepared).await;
            // The owner approved a separate 8s judge budget. Preserve retrieval's
            // existing 5s work budget instead of spending its evidence budget waiting.
            self.deadline_at += i64::try_from(started.elapsed().as_millis()).unwrap_or_default();
            (None, Some(prepared), None)
        } else {
            (Some(generation), None, Some(permit))
        };
        let permit = match permit {
            Some(permit) => permit,
            None => self.read_permit().await?,
        };
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            self.query(page.as_ref(), generation.as_ref(), &vector, prepared)
        })
        .await
        .map_err(|error| {
            CognitionError::new(
                CognitionCode::MemoryRecallOperationFailed,
                error.to_string(),
            )
            .with_source(error)
        })?
    }

    async fn read_permit(&self) -> CognitionResult<tokio::sync::OwnedSemaphorePermit> {
        tokio::select! {
            result = self.admission.clone().acquire_owned() => result.map_err(|source| closed().with_source(source)),
            () = self.shutdown.cancelled() => Err(closed()),
            () = self.caller_cancel.cancelled() => Err(closed()),
        }
    }

    fn prepare(
        &self,
        generation: &MemoryGenerationHandle,
        vector: &VectorFacts,
    ) -> CognitionResult<PreparedSelection> {
        let parse = |value: &str| (self.parse_date)(value).map_or(f64::NAN, |millis| millis as f64);
        let now = || (self.clock)();
        let compare = |a: &str, b: &str| (self.compare_locale)(a, b);
        let clocks = Clocks {
            now_millis: &now,
            parse_date: &parse,
            compare_locale: &compare,
        };
        let read = PageRead {
            data_root: &self.data_root,
            environment: &self.environment,
            generation,
            input: &self.input,
            cursors: &self.cursors,
            deadline_at: self.deadline_at,
        };
        query::prepare_judge(&read, vector, self.metrics.as_deref(), clocks)
    }

    async fn judge(&self, prepared: &mut PreparedSelection) {
        super::super::judge::run(
            &self.input,
            prepared,
            self.judge_port.as_deref(),
            self.metrics.as_deref(),
            &self.shutdown,
            &self.caller_cancel,
        )
        .await;
    }

    /// A cursor continues only on its own generation, `as_of` and arguments.
    fn check_continuation(
        &self,
        page: &Page,
        generation: &MemoryGenerationHandle,
    ) -> CognitionResult<()> {
        let input = &self.input;
        if generation.generation_id != page.inventory.generation_id
            || input.as_of_explicit && input.as_of != page.inventory.as_of
            || cursor::argument_hash(input, &page.inventory.as_of)? != page.inventory.argument_hash
        {
            return Err(continuation::stale());
        }
        Ok(())
    }

    /// The vector lane: searched within 750 ms (or the deadline), or the code
    /// of why it was not.
    async fn vector_facts(
        &self,
        generation: &MemoryGenerationHandle,
    ) -> CognitionResult<VectorFacts> {
        let mut vector = VectorFacts::default();
        let Some(port) = &self.vector_port else {
            vector.code = Some(if generation.embedding.is_none() {
                "embedding_not_configured".into()
            } else {
                "vector_unavailable".into()
            });
            return Ok(vector);
        };
        // A fresh generation also warms through the adapter. Cold initialization
        // outlives this lane's deadline; the first answer still uses text lanes.
        let clock = &self.clock;
        let vector_deadline = self.deadline_at.min(clock() + 750);
        let remaining = u64::try_from(vector_deadline.saturating_sub(clock())).unwrap_or_default();
        let lane = if generation.embedding.is_none() {
            port.warm(generation, &self.input, vector_deadline)
        } else {
            port.search(generation, &self.input, vector_deadline)
        };
        let result = tokio::select! {
            ()=self.shutdown.cancelled()=>return Err(closed()),
            result=tokio::time::timeout(std::time::Duration::from_millis(remaining),
                lane)=>result,
        };
        match result {
            Ok(Ok(_)) if generation.embedding.is_none() => {
                vector.code = Some("embedding_not_configured".into());
            }
            Ok(Ok(matches)) => {
                vector.searched = true;
                vector.diagnostics = matches.diagnostics.clone();
                vector.matches = Some(matches);
            }
            Ok(Err(error)) => vector.code = Some(vector_error_code(&error)),
            Err(_) => vector.code = Some("vector_unavailable".into()),
        }
        Ok(vector)
    }

    /// The first page, or the next page of a cursor (at the cursor's `as_of`).
    fn query(
        &self,
        page: Option<&Page>,
        generation: Option<&MemoryGenerationHandle>,
        vector: &VectorFacts,
        prepared: Option<PreparedSelection>,
    ) -> CognitionResult<RecallResponse> {
        let parse = |value: &str| (self.parse_date)(value).map_or(f64::NAN, |millis| millis as f64);
        let now = || (self.clock)();
        let compare = |a: &str, b: &str| (self.compare_locale)(a, b);
        let clocks = Clocks {
            now_millis: &now,
            parse_date: &parse,
            compare_locale: &compare,
        };
        let current = resolve_active_generation(&self.data_root, &self.environment)?;
        let generation = generation
            .filter(|pinned| pinned.generation_id == current.generation_id)
            .unwrap_or(&current);
        let mut read = PageRead {
            data_root: &self.data_root,
            environment: &self.environment,
            generation,
            input: &self.input,
            cursors: &self.cursors,
            deadline_at: self.deadline_at,
        };
        if let Some(page) = page {
            let mut effective = self.input.clone();
            effective.as_of = page.inventory.as_of.clone();
            read.input = &effective;
            query::continue_page(&read, page, clocks)
        } else {
            query::initial(&read, vector, self.metrics.as_deref(), clocks, prepared)
        }
    }
}

/// A vector port error's message when it is a snake_case code.
fn vector_error_code(error: &CognitionError) -> String {
    let message = error.message();
    if !message.is_empty()
        && message
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
    {
        message
    } else {
        "vector_unavailable".into()
    }
}
