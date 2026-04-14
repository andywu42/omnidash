-- Widen pattern_name from VARCHAR(255) to TEXT to accommodate full pattern signatures
-- from omniintelligence (e.g. "file_access_pattern::co_access: /long/path/a, /long/path/b")
-- which can exceed 255 characters.
ALTER TABLE pattern_learning_artifacts
  ALTER COLUMN pattern_name TYPE text;
