//! Batched ONNX inference and pooling.

use ort::{session::Session, value::Tensor};
use tokenizers::Encoding;

use super::{EXPECTED_DIMENSION, EmbeddingFailure};

/// Texts run through the model together.
pub(super) const BATCH_TEXTS: usize = 16;
/// Padded tokens (texts times the longest text) one batch may hold. Attention
/// memory grows with the square of the sequence length, so long texts run in
/// small batches, alone above this size.
pub(super) const BATCH_TOKENS: usize = 4096;

/// Plans batches of the texts at `lengths` (token counts): longest first, so
/// similar lengths share a batch and padding stays small. Each batch is a list
/// of positions into `lengths`.
pub(super) fn plan_batches(lengths: &[usize]) -> Vec<Vec<usize>> {
    let mut order: Vec<usize> = (0..lengths.len()).collect();
    order.sort_by_key(|index| std::cmp::Reverse(lengths.get(*index).copied().unwrap_or(0)));
    let mut batches: Vec<Vec<usize>> = Vec::new();
    let mut longest = 0;
    for index in order {
        let length = lengths.get(index).copied().unwrap_or(0);
        let fits = batches.last().is_some_and(|batch| {
            batch.len() < BATCH_TEXTS && (batch.len() + 1) * longest.max(length) <= BATCH_TOKENS
        });
        if fits {
            if let Some(batch) = batches.last_mut() {
                batch.push(index);
            }
        } else {
            batches.push(vec![index]);
            longest = length;
        }
    }
    batches
}

/// Runs the encodings through the model as one padded batch and pools each
/// text's vector: the first token (`checked`) or the mean over the attention
/// mask. The vectors come back in the order of `batch`, unit length.
pub(super) fn embed_batch(
    session: &mut Session,
    pad_id: i64,
    batch: &[&Encoding],
    checked: bool,
) -> Result<Vec<Vec<f32>>, EmbeddingFailure> {
    let width = batch.iter().map(|encoded| encoded.len()).max().unwrap_or(0);
    let rows = batch.len();
    let mut inputs = Vec::with_capacity(session.inputs().len());
    for input in session.inputs() {
        let (fill, column): (i64, fn(&Encoding) -> Vec<i64>) = match input.name() {
            "input_ids" => (pad_id, |encoded| {
                encoded
                    .get_ids()
                    .iter()
                    .map(|value| i64::from(*value))
                    .collect()
            }),
            "attention_mask" => (0, |encoded| {
                encoded
                    .get_attention_mask()
                    .iter()
                    .map(|value| i64::from(*value))
                    .collect()
            }),
            "token_type_ids" => (0, |encoded| {
                encoded
                    .get_type_ids()
                    .iter()
                    .map(|value| i64::from(*value))
                    .collect()
            }),
            _ => return Err(EmbeddingFailure::new("embed_model_input_unsupported")),
        };
        let mut values = Vec::with_capacity(rows * width);
        for encoded in batch {
            let row = column(encoded);
            let padding = width - row.len();
            values.extend(row);
            values.extend(std::iter::repeat_n(fill, padding));
        }
        let tensor = Tensor::from_array(([rows, width], values))
            .map_err(EmbeddingFailure::caused("embed_inference_failed"))?;
        inputs.push((input.name().to_owned(), tensor));
    }
    let outputs = session
        .run(inputs)
        .map_err(EmbeddingFailure::caused("embed_inference_failed"))?;
    let output = ["last_hidden_state", "logits", "token_embeddings"]
        .into_iter()
        .find_map(|name| outputs.get(name))
        .ok_or(EmbeddingFailure::new("embed_output_invalid"))?;
    let (shape, data) = output
        .try_extract_tensor::<f32>()
        .map_err(EmbeddingFailure::caused("embed_output_invalid"))?;
    let expected_shape = [
        i64::try_from(rows).unwrap_or(i64::MAX),
        i64::try_from(width).unwrap_or(i64::MAX),
        i64::try_from(EXPECTED_DIMENSION).unwrap_or(i64::MAX),
    ];
    if **shape != expected_shape || data.len() != rows * width * EXPECTED_DIMENSION {
        return Err(EmbeddingFailure::new("embed_dimension_invalid"));
    }
    let mut vectors = Vec::with_capacity(rows);
    for (row, encoded) in batch.iter().enumerate() {
        let start = row * width * EXPECTED_DIMENSION;
        let tokens = data
            .get(start..start + width * EXPECTED_DIMENSION)
            .ok_or(EmbeddingFailure::new("embed_output_invalid"))?;
        vectors.push(pool(tokens, encoded, checked)?);
    }
    Ok(vectors)
}

/// One text's unit-length vector from its token embeddings.
fn pool(tokens: &[f32], encoded: &Encoding, checked: bool) -> Result<Vec<f32>, EmbeddingFailure> {
    let mut vector = vec![0.0_f32; EXPECTED_DIMENSION];
    if checked {
        let first = tokens
            .get(..EXPECTED_DIMENSION)
            .ok_or(EmbeddingFailure::new("embed_output_invalid"))?;
        vector.copy_from_slice(first);
    } else {
        let mask = encoded.get_attention_mask();
        let count: u32 = mask.iter().sum();
        if count == 0 {
            return Err(EmbeddingFailure::new("embed_output_invalid"));
        }
        for (active, row) in mask.iter().zip(tokens.chunks_exact(EXPECTED_DIMENSION)) {
            if *active == 0 {
                continue;
            }
            for (total, value) in vector.iter_mut().zip(row) {
                *total += *value / count as f32;
            }
        }
    }
    normalize(&mut vector)?;
    Ok(vector)
}

fn normalize(vector: &mut [f32]) -> Result<(), EmbeddingFailure> {
    let squared: f64 = vector
        .iter()
        .map(|value| f64::from(*value) * f64::from(*value))
        .sum();
    if !squared.is_finite() || squared <= 0.0 {
        return Err(EmbeddingFailure::new("embed_output_invalid"));
    }
    #[expect(
        clippy::cast_possible_truncation,
        reason = "the finite positive norm of f32 components fits f32"
    )]
    let norm = squared.sqrt() as f32;
    for value in vector.iter_mut() {
        *value /= norm;
    }
    if vector.iter().any(|value| !value.is_finite()) {
        return Err(EmbeddingFailure::new("embed_output_invalid"));
    }
    Ok(())
}
