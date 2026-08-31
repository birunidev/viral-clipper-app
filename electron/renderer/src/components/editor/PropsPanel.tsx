import { Button } from "@/components/ui/button";
import { CaptionStylePicker } from "@/components/project/caption-style-picker";
import { useEditPlanStore } from "@/stores/editPlanStore";

export function PropsPanel({
  captionStyles,
  selectedStyleId,
  onSave,
  onDiscard,
}: {
  captionStyles: { id: string; label: string; config: unknown }[];
  selectedStyleId?: string | null;
  onSave?: () => void;
  onDiscard?: () => void;
}) {
  const { editPlan, dirty, patch } = useEditPlanStore();

  if (!editPlan) return <p className="text-xs text-ink-tertiary">No edit plan yet.</p>;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-xs font-medium text-ink-secondary">Aspect ratio (ratio-locked drag)</p>
        <div className="mt-2 flex gap-1.5">
          {(["9:16", "4:5", "1:1", "16:9"] as const).map((a) => (
            <button
              key={a}
              onClick={() => patch((d) => { d.output.aspect_ratio = a; })}
              className={`rounded-lg border px-2.5 py-1.5 text-xs ${editPlan.output.aspect_ratio === a ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface-2 text-ink-secondary"}`}
            >
              {a}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="text-xs font-medium text-ink-secondary">Subtitle preset (global)</p>
        <div className="mt-2">
          <CaptionStylePicker styles={captionStyles as never} selectedId={selectedStyleId ?? editPlan.output.caption_style_id ?? null} onSelect={(id) => patch((d) => { d.output.caption_style_id = id; })} />
        </div>
      </div>

      <div>
        <p className="text-xs font-medium text-ink-secondary">Tightness</p>
        <div className="mt-2 flex gap-1.5">
          {(["natural", "social", "aggressive"] as const).map((t) => (
            <button key={t} onClick={() => patch((d) => { d.output.tightness = t; })} className={`rounded-lg border px-2.5 py-1.5 text-xs capitalize ${editPlan.output.tightness === t ? "border-accent bg-accent-soft" : "border-line bg-surface-2"}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="flex gap-2 border-t border-line pt-4">
        <Button size="sm" variant="primary" disabled={!dirty} onClick={onSave} className="flex-1">Save</Button>
        <Button size="sm" variant="ghost" disabled={!dirty} onClick={onDiscard}>Discard</Button>
      </div>
      {dirty && <p className="text-[11px] text-amber-600">Unsaved changes — press Save.</p>}
    </div>
  );
}
