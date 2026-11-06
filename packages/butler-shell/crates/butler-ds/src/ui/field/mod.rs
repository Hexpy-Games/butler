//! DS Field family (shadcn/ui/field.tsx, Field.module.css): FieldSet, FieldLegend, FieldGroup,
//! Field, FieldContent, FieldLabel, FieldTitle, FieldDescription, FieldSeparator, FieldError.
//! They lay a label, a description, a control and an error out with token gaps.
mod container;
mod parts;

pub use container::{Field, FieldContent, Orientation};
pub use parts::{
    FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSeparator, FieldSet,
    FieldTitle,
};
