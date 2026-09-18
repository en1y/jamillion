-- v1.0.5: not every song or album question asks for the artist and the title.
-- "How is this artist's name spelled?" over a cover is answered "all caps", and
-- with both boxes on, the catalog refuses every answer the question actually
-- wants. Asking for no field is now a question with one free box, scored against
-- the typed key exactly as a rarest question is.
ALTER TABLE questions DROP CONSTRAINT asks_something;
