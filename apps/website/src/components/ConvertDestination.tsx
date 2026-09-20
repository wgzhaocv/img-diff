import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useConvertStore, type Destination } from "@/lib/stores/convertStore";

// 出力の落とし先。**入力フォルダには決して書かない**（SPEC §5.4）ので、
// 選べるのは「別に選ぶフォルダ」か zip の 2 つだけ。

const DESTINATIONS: { value: Destination; label: string }[] = [
  { value: "folder", label: "フォルダへ保存" },
  { value: "zip", label: "zip でダウンロード" },
];

export function ConvertDestination() {
  const destination = useConvertStore((s) => s.form.destination);
  const overwrite = useConvertStore((s) => s.form.overwrite);
  const converting = useConvertStore((s) => s.status === "converting");
  const setForm = useConvertStore((s) => s.setForm);

  return (
    <fieldset className="space-y-3" disabled={converting}>
      <legend className="text-sm font-medium">保存先</legend>
      <Tabs value={destination} onValueChange={(v) => setForm({ destination: v as Destination })}>
        <TabsList>
          {DESTINATIONS.map((d) => (
            <TabsTrigger key={d.value} value={d.value}>
              {d.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {destination === "folder" ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            実行すると保存先フォルダを聞きます。元のフォルダ構造を保って書き出し、
            <strong className="font-medium text-foreground">
              同名のファイルが既にあれば飛ばします
            </strong>
            。
          </p>
          <label className="flex w-fit items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={overwrite}
              onChange={(e) => setForm({ overwrite: e.target.checked })}
            />
            既にあるファイルを上書きする
          </label>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          全件を 1 つの zip
          にまとめてダウンロードします。枚数が多いときはフォルダ保存の方が軽いです。
        </p>
      )}
    </fieldset>
  );
}
