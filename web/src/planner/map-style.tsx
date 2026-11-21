// "Map style" in Map & rides (the Map tab): the options of the outdoor style (src/map/look.ts), one
// row each, remembered on the device. Meant for trying the style out; Graded on straw is the default.
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useMapLook } from "@/lib/map-look";
import { DEFAULT_LOOK, LOOK_CHOICES, type MapLook, sameLook } from "@/map/look";
import { Switch } from "./parts";

type Choice = keyof typeof LOOK_CHOICES;
const ROWS: { key: Choice; name: string }[] = [
  { key: "tracks", name: "Tracks" },
  { key: "weight", name: "Lines" },
  { key: "ground", name: "Ground" },
  { key: "relief", name: "Relief" },
];

export function MapStyleOptions({ relief }: { relief: boolean }) {
  const [look, set] = useMapLook();
  return (
    <div className="space-y-2" data-testid="map-style">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 font-semibold text-sm">Map style</span>
        {!sameLook(look, DEFAULT_LOOK) && (
          <button
            type="button"
            data-testid="map-style-reset"
            className="text-muted-foreground text-xs underline-offset-2 hover:underline"
            onClick={() => set(DEFAULT_LOOK)}
          >
            Reset
          </button>
        )}
      </div>
      {ROWS.filter((r) => relief || r.key !== "relief").map(({ key, name }) => (
        <div key={key} className="flex items-center gap-3">
          <span className="min-w-0 flex-1 text-sm">{name}</span>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-label={name}
            value={look[key]}
            onValueChange={(v) => v && set({ [key]: v } as Partial<MapLook>)}
          >
            {LOOK_CHOICES[key].map((v) => (
              <ToggleGroupItem
                key={v}
                value={v}
                data-testid={`look-${key}-${v}`}
                className="capitalize data-[state=on]:bg-foreground data-[state=on]:text-background"
              >
                {v}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      ))}
      {relief && (
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1 text-sm">Contour lines</span>
          <Switch
            on={look.contours}
            name="Contour lines"
            testid="look-contours"
            onClick={() => set({ contours: !look.contours })}
          />
        </div>
      )}
    </div>
  );
}
