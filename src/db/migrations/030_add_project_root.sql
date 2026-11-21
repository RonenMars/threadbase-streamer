-- Two worktrees of one repo run from different directories, so the cwd-keyed
-- project_path made them two projects. project_root is the main checkout the
-- cwd belongs to; worktree_path is the cwd itself when it is a linked worktree
-- (NULL for a main checkout). Both are NULL until resolved from disk, and a
-- NULL project_root means "group by project_path", as before. Filled on write
-- and by a boot backfill; never cleared, so a deleted worktree keeps its group.
ALTER TABLE conversation_meta ADD COLUMN project_root TEXT;
ALTER TABLE conversation_meta ADD COLUMN worktree_path TEXT;
CREATE INDEX IF NOT EXISTS idx_meta_project_root ON conversation_meta(project_root);

ALTER TABLE projects ADD COLUMN project_root TEXT;
ALTER TABLE projects ADD COLUMN worktree_path TEXT;
