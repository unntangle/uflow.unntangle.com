// ============================================================
// TypeBadge — where a job sits in the parent/child hierarchy
// ============================================================
// Added by migrations/2026-08-28_add_parent_child_models.sql.
// Every job is either standalone ('parent') or derived from
// another model ('child', carrying a parent_id).
//
// Shared so the Type column reads identically on every table —
// Overview, List Jobs, Reassign, Change Status, Download, Change
// Type, and both role dashboards. A per-page reimplementation is
// how "Child" ends up meaning something subtly different on one
// screen than another.
//
// Deliberately NOT a status badge. It uses a quiet outline
// rather than a filled colour token, because type is a fixed
// property of the job, not a stage it's passing through — giving
// it the same visual weight as IQA / Approved would make the
// table read as though something needs attention.
//
// parentName is optional: some pages load a filtered slice of
// jobs (Reassign only loads open ones), so a child's parent may
// not be in the fetched set. The badge stays correct either way
// and simply omits the "of X" line when it can't resolve a name.
//
// A child whose parent_id is null is ORPHANED — the FK is
// ON DELETE SET NULL, so deleting a parent leaves its children's
// work intact but unlinked. That's surfaced rather than hidden,
// since the fix is a manual re-parent from Jobs → Change Type.

export type ModelType = 'parent' | 'child';

export default function TypeBadge({
  modelType,
  parentId,
  parentName,
  showParent = true,
}: {
  modelType: ModelType | null | undefined;
  parentId?: string | null;
  parentName?: string | null;
  // Set false on narrow tables where the second line would wrap
  // badly; the badge then renders as a bare Parent/Child pill.
  showParent?: boolean;
}) {
  const isChild = modelType === 'child';
  const orphaned = isChild && !parentId;

  return (
    <span style={{ display: 'inline-block', lineHeight: 1.3 }}>
      <span
        style={{
          display: 'inline-block',
          border: '1px solid var(--border)',
          borderRadius: 999,
          padding: '2px 10px',
          fontSize: 12,
          whiteSpace: 'nowrap',
          color: isChild ? 'var(--text-dim)' : 'inherit',
        }}
        title={
          isChild
            ? 'Derived from another model. Its own job with its own upload and QA cycle.'
            : 'A standalone model.'
        }
      >
        {isChild ? 'Child' : 'Parent'}
      </span>
      {showParent && isChild && (
        <span
          style={{
            display: 'block',
            fontSize: 11,
            marginTop: 3,
            color: orphaned ? '#92400e' : 'var(--text-faint)',
          }}
        >
          {orphaned
            ? '⚠ parent removed'
            : parentName
            ? `of ${parentName}`
            : ''}
        </span>
      )}
    </span>
  );
}
