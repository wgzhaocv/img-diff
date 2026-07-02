import { useMemo, type ReactNode } from "react";
import { CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Thumb } from "@/components/Thumb";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format";
import { STRICTNESS_LABEL, type DupGroup, type ImageRecord } from "@/lib/core";
import { useScanStore } from "@/lib/stores/scanStore";

// 表示データ（結果・グループ）はストアから直接読む（画面からの props 経由の受け渡しを避ける）。
export function DuplicateGroups() {
  const result = useScanStore((s) => s.result);
  const groups = useScanStore((s) => s.groups);

  const images = result?.images ?? [];
  const fileByPath = result?.fileByPath;
  const thumbByPath = result?.thumbByPath;
  const rootId = result?.rootId;

  const imageByPath = useMemo(() => new Map(images.map((r) => [r.path, r])), [images]);
  const { duplicates, reclaimable } = useMemo(
    () => ({
      duplicates: groups.reduce((sum, g) => sum + g.members.length - 1, 0),
      reclaimable: groups.reduce((sum, g) => sum + (g.autoDeletable ? g.reclaimableBytes : 0), 0),
    }),
    [groups],
  );

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <Stat label="画像" value={images.length} />
        <Stat label="重複グループ" value={groups.length} />
        <Stat label="重複" value={duplicates} />
        <Stat className="ml-auto" label="回収可能" value={formatBytes(reclaimable)} />
      </div>

      {groups.length === 0 ? (
        <Card className="p-8 text-center text-muted-foreground">重複は見つかりませんでした。</Card>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <GroupCard
              key={group.id}
              group={group}
              imageByPath={imageByPath}
              fileByPath={fileByPath}
              thumbByPath={thumbByPath}
              rootId={rootId}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  className,
}: {
  label: string;
  value: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <span className="text-muted-foreground">{label} </span>
      <span className="num font-medium">{value}</span>
    </div>
  );
}

function GroupCard({
  group,
  imageByPath,
  fileByPath,
  thumbByPath,
  rootId,
}: {
  group: DupGroup;
  imageByPath: Map<string, ImageRecord>;
  fileByPath?: Map<string, File>;
  thumbByPath?: Map<string, Blob>;
  rootId?: string;
}) {
  // keeper（残す 1 枚）を先頭に。
  const ordered = [group.keeper, ...group.members.filter((m) => m !== group.keeper)];
  return (
    <Card className="gap-3 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <Badge variant="secondary">{STRICTNESS_LABEL[group.strictness]}</Badge>
        <span className="text-muted-foreground">
          <span className="num">{group.members.length}</span> 枚
        </span>
        {group.autoDeletable ? (
          <span className="text-muted-foreground">
            回収可能 <span className="num">{formatBytes(group.reclaimableBytes)}</span>
          </span>
        ) : (
          <span className="text-warning">要目視（自動削除しない）</span>
        )}
        {group.maxHamming != null ? (
          <span className="text-muted-foreground">
            距離 ≤ <span className="num">{group.maxHamming}</span>
          </span>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {ordered.map((path) => {
          const rec = imageByPath.get(path);
          const keeper = path === group.keeper;
          return (
            <figure key={path} className="space-y-1">
              <div className="relative">
                <Thumb
                  file={fileByPath?.get(path)}
                  thumb={thumbByPath?.get(path)}
                  rootId={rootId}
                  path={path}
                  alt={path}
                  className={cn("aspect-square", keeper && "ring-2 ring-primary")}
                />
                {keeper ? (
                  <Badge className="absolute left-1 top-1 gap-1">
                    <CheckCircle2 />
                    残す
                  </Badge>
                ) : null}
              </div>
              <figcaption className="truncate text-xs text-muted-foreground" title={path}>
                {path.split("/").pop()}
              </figcaption>
              {rec ? (
                <div className="num text-xs text-muted-foreground">
                  {rec.width}×{rec.height} · {formatBytes(rec.bytes)}
                </div>
              ) : null}
            </figure>
          );
        })}
      </div>
    </Card>
  );
}
