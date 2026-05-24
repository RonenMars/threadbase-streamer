/**
 * Resolve a user-visible title for a ProjectChat row.
 *
 * Mobile (ConversationListItem.tsx) renders `title?.trim() || pathSuffix ||
 * ''`, so when title and projectPath are both blank the row appears empty.
 * This helper produces a non-empty title for every input by falling back
 * through title → slug-ish projectName → path suffix → short id.
 */
export function deriveProjectChatTitle(input: {
  title: string | null | undefined;
  projectName: string | null | undefined;
  projectPath: string | null | undefined;
  id: string;
}): string {
  const trimmed = input.title?.trim();
  if (trimmed) return trimmed;
  const name = input.projectName?.trim();
  if (name) return name;
  const pathSuffix = input.projectPath
    ? input.projectPath.split(/[/\\]/).filter(Boolean).slice(-2).join("/")
    : "";
  if (pathSuffix) return pathSuffix;
  return `Untitled · ${input.id.slice(0, 8)}`;
}
